// ======================================
// index.js FINAL (PART 1 / 4)
// - 내전 모집
// - 10/20 모드
// - 구글 시트 기록
// - Riot Tournament Code 생성
// - 특정 채널 제한 (#내전-모집)
// ======================================

import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  REST,
  Routes,
} from "discord.js";

import axios from "axios";
import cron from "node-cron";
import { google } from "googleapis";

const TOKEN = process.env.TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CHANNEL_ID = process.env.CHANNEL_ID; // 내전 모집 메시지 올라가는 채널
const SHEET_ID = process.env.SHEET_ID;
const GOOGLE_CREDENTIALS = JSON.parse(
  process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || "{}"
);
const RIOT_API_KEY = process.env.RIOT_API_KEY;

// 굴뚝딱가리 명령어 허용 채널
const ALLOWED_CHANNEL = "1439215856440578078";

// Google Sheet
const SHEET_NAME = "기록";
const RANGE_20P = `${SHEET_NAME}!L18:L37`;
const RANGE_10P = `${SHEET_NAME}!M18:M37`;
const RANGE_RESET = `${SHEET_NAME}!A1:Z1000`;

let currentMode = "10p";
let signupMessageId = null;
let participants = [];
let waitList = [];
let lockSignup = false;

// =====================
// Google Sheets 설정
// =====================
const auth = new google.auth.GoogleAuth({
  credentials: GOOGLE_CREDENTIALS,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// =====================
// Riot Tournament API
// =====================
const REGION = "asia";
const RIOT_API_HEADER = {
  headers: { "X-Riot-Token": RIOT_API_KEY },
};

async function createProvider() {
  try {
    const res = await axios.post(
      `https://${REGION}.api.riotgames.com/lol/tournament/v5/providers`,
      {
        region: "KR",
        url: "https://discord.gg",
      },
      RIOT_API_HEADER,
    );
    return res.data;
  } catch (err) {
    console.error("Provider Error:", err.response?.data || err);
    return null;
  }
}

async function createTournament(providerId) {
  try {
    const res = await axios.post(
      `https://${REGION}.api.riotgames.com/lol/tournament/v5/tournaments`,
      {
        name: "Inhouse BO3",
        providerId,
      },
      RIOT_API_HEADER
    );
    return res.data;
  } catch (err) {
    console.error("Tournament Create Error:", err.response?.data || err);
    return null;
  }
}

// 코드 3개 생성(BO3용)
async function generateCodes(tournamentId, teamSize = 5) {
  try {
    const res = await axios.post(
      `https://${REGION}.api.riotgames.com/lol/tournament/v5/codes?tournamentId=${tournamentId}&count=3`,
      {
        mapType: "SUMMONERS_RIFT",
        pickType: "TOURNAMENT_DRAFT",
        teamSize,
      },
      RIOT_API_HEADER,
    );
    return res.data;
  } catch (err) {
    console.error("Generate Code Error:", err.response?.data || err);
    return null;
  }
}
// ======================================
// index.js FINAL (PART 2 / 4)
// ======================================

// ============ 구글 시트 읽기/쓰기 =============
async function sheetRead(range) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
  });
  return res.data.values || [];
}

async function sheetWrite(range, values) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    resource: { values },
  });
}

// 참가자 정보를 시트에 기록
async function syncParticipantsToSheet() {
  if (currentMode === "10p") {
    const rows = participants.map((v) => [v]);
    await sheetWrite(RANGE_10P, rows);
  } else {
    const rows = participants.map((v) => [v]);
    await sheetWrite(RANGE_20P, rows);
  }
}

// ==============================
// 임베드(모집 메시지 UI)
// ==============================
function buildRecruitEmbed() {
  return new EmbedBuilder()
    .setColor("#00A1FF")
    .setTitle("🔥 굴뚝딱가리 내전 모집 🔥")
    .setDescription("버튼을 눌러 참가 또는 취소하세요!")
    .addFields(
      {
        name: `참가자 (${participants.length}${
          currentMode === "10p" ? "/10" : "/20"
        })`,
        value: participants.length
          ? participants.map((id) => `<@${id}>`).join("\n")
          : "없음",
      },
      {
        name: `대기자 (${waitList.length})`,
        value: waitList.length
          ? waitList.map((id) => `<@${id}>`).join("\n")
          : "없음",
      }
    )
    .setTimestamp();
}

// ==============================
// 버튼 UI
// ==============================
const rowButtons = new ActionRowBuilder().addComponents(
  new ButtonBuilder()
    .setCustomId("join")
    .setLabel("참가")
    .setStyle(ButtonStyle.Success),

  new ButtonBuilder()
    .setCustomId("leave")
    .setLabel("취소")
    .setStyle(ButtonStyle.Danger),
);

// ==============================
// Slash Commands 등록
// ==============================
const commands = [
  new SlashCommandBuilder()
    .setName("내전모집")
    .setDescription("굴뚝 내전 모집 메시지를 생성합니다."),
  new SlashCommandBuilder()
    .setName("참가자")
    .setDescription("현재 참가자/대기자 확인"),
  new SlashCommandBuilder()
    .setName("초기화")
    .setDescription("내전 참가자/대기자 초기화"),
  new SlashCommandBuilder()
    .setName("20")
    .setDescription("20인 모드로 변경"),
  new SlashCommandBuilder()
    .setName("re")
    .setDescription("10인 모드로 변경"),
  new SlashCommandBuilder()
    .setName("굴뚝딱가리")
    .setDescription("윤섭 호출"),
  new SlashCommandBuilder()
    .setName("내전코드")
    .setDescription("BO3 내전 토너먼트 코드를 생성합니다."),
].map((c) => c.toJSON());

// ==============================
// 명령어 업로드
// ==============================
const rest = new REST({ version: "10" }).setToken(TOKEN);

async function registerCommands() {
  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log("✔ 슬래시 명령어 등록 완료");
  } catch (err) {
    console.error("Slash Commands 등록 실패:", err);
  }
}

registerCommands();

// ==============================
// Discord Client
// ==============================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

client.once("ready", () => {
  console.log(`🔥 로그인 성공: ${client.user.tag}`);
});
// ======================================
// index.js FINAL (PART 3 / 4)
// ======================================

// ======================================
// interactionCreate — 명령어 & 버튼 처리
// ======================================
client.on("interactionCreate", async (interaction) => {
  try {
    // ---------------------------
    // 1) 슬래시 명령어 채널 제한
    // ---------------------------
    if (interaction.isChatInputCommand()) {
      if (interaction.channelId !== ALLOWED_CHANNEL) {
        return interaction.reply({
          content: `❌ 이 명령어는 <#${ALLOWED_CHANNEL}> 채널에서만 사용할 수 있습니다.`,
          ephemeral: true
        });
      }
    }

    // ---------------------------
    // 2) Slash Commands 처리
    // ---------------------------
    const { commandName } = interaction;

    // ========== /내전모집 ==========
    if (commandName === "내전모집") {
      participants = [];
      waitList = [];

      const embed = buildRecruitEmbed();
      const msg = await interaction.reply({
        content: "@everyone 굴뚝딱가리 내전 모집 시작!",
        embeds: [embed],
        components: [rowButtons],
        allowedMentions: { parse: ["everyone"] }
      });

      signupMessageId = msg.id;
      return;
    }

    // ========== /참가자 ==========
    if (commandName === "참가자") {
      return interaction.reply({
        embeds: [buildRecruitEmbed()],
        ephemeral: true
      });
    }

    // ========== /초기화 ==========
    if (commandName === "초기화") {
      participants = [];
      waitList = [];
      await sheetWrite(RANGE_RESET, [[""]]);
      return interaction.reply("✔ 참가자/대기자를 초기화했습니다.");
    }

    // ========== /20 ==========
    if (commandName === "20") {
      currentMode = "20p";
      if (participants.length > 20) {
        waitList = waitList.concat(participants.slice(20));
        participants = participants.slice(0, 20);
      }
      return interaction.reply("🔄 모드를 **20인 모드**로 전환했습니다.");
    }

    // ========== /re ==========
    if (commandName === "re") {
      currentMode = "10p";
      if (participants.length > 10) {
        waitList = waitList.concat(participants.slice(10));
        participants = participants.slice(0, 10);
      }
      return interaction.reply("🔄 모드를 **10인 모드**로 전환했습니다.");
    }

    // ========== /굴뚝딱가리 ==========
    if (commandName === "굴뚝딱가리") {
      if (interaction.channelId !== ALLOWED_CHANNEL) {
        return interaction.reply({
          content: `❌ 이 명령어는 <#${ALLOWED_CHANNEL}> 채널에서만 사용할 수 있습니다.`,
          ephemeral: true
        });
      }

      const members = await interaction.guild.members.fetch().catch(() => null);
      if (!members) {
        return interaction.reply({
          content: "멤버 정보를 가져올 수 없습니다.",
          ephemeral: true
        });
      }

      const target = members.find(
        (m) =>
          m.nickname === "윤섭" ||
          m.user.globalName === "윤섭" ||
          m.user.username === "윤섭"
      );

      if (!target) {
        return interaction.reply({
          content: "❌ 윤섭을 찾을 수 없습니다.",
          ephemeral: true
        });
      }

      return interaction.reply({
        content: `<@${target.id}> 윤섭아 너 부른다.`,
        ephemeral: false
      });
    }

    // ========== /내전코드 ==========
    if (commandName === "내전코드") {
      await interaction.deferReply();

      try {
        const providerId = await createProvider();
        if (!providerId) throw new Error("Provider 생성 실패");

        const tournamentId = await createTournament(providerId);
        if (!tournamentId) throw new Error("Tournament 생성 실패");

        const codes = await generateCodes(tournamentId);
        if (!codes || codes.length < 3) {
          throw new Error("코드 생성 실패");
        }

        await interaction.editReply({
          content:
            `🎉 **BO3 내전 코드 생성 완료!**\n\n` +
            `1경기: \`${codes[0]}\`\n` +
            `2경기: \`${codes[1]}\`\n` +
            `3경기: \`${codes[2]}\`\n`
        });

      } catch (err) {
        console.error(err);
        return interaction.editReply(`❌ 오류: ${err.message}`);
      }

      return;
    }

    // ---------------------------
    // 3) 버튼(참가/취소)
    // ---------------------------
    if (interaction.isButton()) {
      const userId = interaction.user.id;

      // 참가 버튼
      if (interaction.customId === "join") {
        if (participants.includes(userId)) {
          return interaction.reply({ content: "이미 참가 중입니다!", ephemeral: true });
        }

        if (currentMode === "10p" && participants.length < 10) {
          participants.push(userId);
        } else if (currentMode === "20p" && participants.length < 20) {
          participants.push(userId);
        } else {
          if (!waitList.includes(userId)) waitList.push(userId);
        }
      }

      // 취소 버튼
      if (interaction.customId === "leave") {
        participants = participants.filter((id) => id !== userId);
        waitList = waitList.filter((id) => id !== userId);

        if (currentMode === "10p" && participants.length < 10 && waitList.length > 0) {
          participants.push(waitList.shift());
        }

        if (currentMode === "20p" && participants.length < 20 && waitList.length > 0) {
          participants.push(waitList.shift());
        }
      }

      const channel = await client.channels.fetch(interaction.channelId);
      const msg = await channel.messages.fetch(signupMessageId);

      await msg.edit({
        embeds: [buildRecruitEmbed()],
        components: [rowButtons],
      });

      await interaction.deferUpdate();
    }
  } catch (err) {
    console.error("⚠️ interaction 오류:", err);
  }
});
// ======================================
// index.js FINAL (PART 4 / 4)
// ======================================

// ======================================
// 자동 모집 (옵션) - 매일 17시에 내전 모집 메시지 새로 올리기
// ======================================
cron.schedule(
  "0 17 * * *",
  async () => {
    try {
      const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
      if (!channel || !channel.isTextBased()) return;

      // 매일 17시에 참가자/대기자 초기화
      participants = [];
      waitList = [];
      currentMode = "10p";

      const embed = buildRecruitEmbed();
      const msg = await channel.send({
        content: "@everyone 굴뚝딱가리 내일도 내전 갑니다! 참가하실 분은 버튼 눌러주세요!",
        embeds: [embed],
        components: [rowButtons],
        allowedMentions: { parse: ["everyone"] }
      });

      signupMessageId = msg.id;
      console.log("⏰ 매일 17시 자동 모집 메시지 전송 완료");
    } catch (err) {
      console.error("자동 모집 실패:", err);
    }
  },
  {
    timezone: "Asia/Seoul",
  }
);

// ======================================
// 디스코드 봇 로그인
// ======================================
client.login(TOKEN).catch((err) => {
  console.error("디스코드 로그인 실패:", err);
});
