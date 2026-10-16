import { Client, Collection, Events, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, REST, Routes } from 'discord.js';
import 'dotenv/config';

// ═══════════════════════════════════════════════
// 1. CONFIGURATION
// ═══════════════════════════════════════════════
const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const FOOTBALL_KEY = process.env.FOOTBALL_KEY;
const ODDS_API_KEY = process.env.ODDS_API;

const FOOTBALL_BASE_URL = 'https://footballdata.io/api/v1';
const ODDS_BASE_URL = 'https://api.the-odds-api.com/v4';

// ═══════════════════════════════════════════════
// 2. SERVICES — Appels API
// ═══════════════════════════════════════════════
async function requestFootball(endpoint) {
  const response = await fetch(`${FOOTBALL_BASE_URL}${endpoint}`, {
    headers: { Authorization: `Bearer ${FOOTBALL_KEY}`, Accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`Erreur Football API (${response.status})`);
  return response.json();
}

async function searchTeam(name) {
  const data = await requestFootball(`/teams?search=${encodeURIComponent(name)}`);
  return data?.data?.[0] ?? null;
}

async function findUpcomingMatch(homeTeamId, awayTeamId) {
  const data = await requestFootball(`/fixtures/upcoming?team1=${homeTeamId}&team2=${awayTeamId}`);
  return data?.data?.[0] ?? null;
}

async function getMatchProbabilities(matchId) {
  const data = await requestFootball(`/matches/${matchId}/probabilities`);
  return data?.data ?? null;
}

async function getOdds(homeTeamName, awayTeamName) {
  try {
    const sport = 'soccer_france_ligue_one';
    const url = `${ODDS_BASE_URL}/sports/${sport}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h`;
    const response = await fetch(url);
    if (!response.ok) return null;

    const data = await response.json();
    const match = data.find(m =>
      m.home_team.includes(homeTeamName) && m.away_team.includes(awayTeamName)
    );
    if (!match || !match.bookmakers?.[0]?.markets?.[0]?.outcomes) return null;

    const outcomes = match.bookmakers[0].markets[0].outcomes;
    return {
      home: outcomes.find(o => o.name === match.home_team)?.price ?? 'N/A',
      draw: outcomes.find(o => o.name === 'Draw')?.price ?? 'N/A',
      away: outcomes.find(o => o.name === match.away_team)?.price ?? 'N/A'
    };
  } catch (error) {
    console.warn('Cotes indisponibles:', error.message);
    return null;
  }
}

// ═══════════════════════════════════════════════
// 3. LOGIQUE DE PRÉDICTION
// ═══════════════════════════════════════════════
async function getPrediction(homeTeamName, awayTeamName) {
  const [homeTeam, awayTeam] = await Promise.all([
    searchTeam(homeTeamName),
    searchTeam(awayTeamName)
  ]);
  if (!homeTeam) throw new Error(`Équipe introuvable : ${homeTeamName}`);
  if (!awayTeam) throw new Error(`Équipe introuvable : ${awayTeamName}`);

  const match = await findUpcomingMatch(homeTeam.id, awayTeam.id);
  if (!match) throw new Error('Aucun match à venir trouvé entre ces deux équipes.');

  const probs = await getMatchProbabilities(match.id);
  if (!probs) throw new Error("L'API n'a pas retourné de probabilités pour ce match.");

  const odds = await getOdds(homeTeamName, awayTeamName);

  return {
    homeWinProb: Math.round((probs.home_win ?? 0) * 100),
    drawProb: Math.round((probs.draw ?? 0) * 100),
    awayWinProb: Math.round((probs.away_win ?? 0) * 100),
    odds
  };
}

// ═══════════════════════════════════════════════
// 4. DÉFINITION DE LA COMMANDE SLASH
// ═══════════════════════════════════════════════
const commandsData = [
  new SlashCommandBuilder()
    .setName('predire')
    .setDescription("Prédit le résultat d'un match.")
    .addStringOption(opt =>
      opt.setName('equipe_domicile').setDescription("L'équipe qui reçoit.").setRequired(true))
    .addStringOption(opt =>
      opt.setName('equipe_exterieur').setDescription("L'équipe qui se déplace.").setRequired(true))
    .toJSON()
];

// ═══════════════════════════════════════════════
// 5. MODE DÉPLOIEMENT (npm run deploy)
// ═══════════════════════════════════════════════
if (process.argv.includes('--deploy')) {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  try {
    console.log(`🔄 Enregistrement de ${commandsData.length} commande(s)...`);
    const data = await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commandsData }
    );
    console.log(`✅ ${data.length} commande(s) enregistrée(s) avec succès.`);
  } catch (error) {
    console.error(error);
  }
  process.exit(0);
}

// ═══════════════════════════════════════════════
// 6. MODE BOT (npm start)
// ═══════════════════════════════════════════════
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.commands = new Collection();
client.commands.set('predire', { data: commandsData[0], execute: executePredire });

async function executePredire(interaction) {
  const homeTeam = interaction.options.getString('equipe_domicile');
  const awayTeam = interaction.options.getString('equipe_exterieur');

  await interaction.deferReply();

  try {
    const prediction = await getPrediction(homeTeam, awayTeam);

    const embed = new EmbedBuilder()
      .setTitle(`🔮 Prédiction : ${homeTeam} vs ${awayTeam}`)
      .setColor(0x00ae86)
      .addFields(
        { name: `🏠 Victoire ${homeTeam}`, value: `${prediction.homeWinProb}%`, inline: true },
        { name: '🤝 Match nul', value: `${prediction.drawProb}%`, inline: true },
        { name: `✈️ Victoire ${awayTeam}`, value: `${prediction.awayWinProb}%`, inline: true }
      )
      .setFooter({ text: "Basé sur l'analyse de données et modèles IA." })
      .setTimestamp();

    if (prediction.odds) {
      embed.addFields({
        name: '💰 Cotes',
        value: `Dom: ${prediction.odds.home} | Nul: ${prediction.odds.draw} | Ext: ${prediction.odds.away}`,
        inline: false
      });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error(error);
    await interaction.editReply(
      `❌ Impossible de générer une prédiction pour **${homeTeam} vs ${awayTeam}**.\n> ${error.message}`
    );
  }
}

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command) return;
  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(error);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: '❌ Une erreur est survenue.', ephemeral: true });
    } else {
      await interaction.reply({ content: '❌ Une erreur est survenue.', ephemeral: true });
    }
  }
});

client.once(Events.ClientReady, c => {
  console.log(`🤖 Prêt ! Connecté en tant que ${c.user.tag}`);
});

client.login(BOT_TOKEN);
