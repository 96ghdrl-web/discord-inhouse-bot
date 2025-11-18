// ===============================
// 굴뚝 내전 봇 index.js — 빠른 응답 + 실시간 갱신 + 데일리 초기화 + 기능추가(+ 내전코드)
// ===============================

const http = require("http");
require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  REST,
  Routes,
  SlashCommandBuilder
} = require("discord.js");

const axios = require("axios"); // Riot API 호출용
const { google } = require("googleapis");
const cron = require("node-cron");
const config = require("./config.json");

// ===============================
// 환경 변수 / 기본 설정
// ===============================
const BOT_TOKEN = process.env.TOKEN;
const SHEET_ID = process.env.SHEET_ID || config.SHEET_ID;
const CHANNEL_ID = process.env.CHANNEL_ID || config.CHANNEL_ID;
const GUILD_ID = process.env.GUILD_ID || config.GUILD_ID;
const RIOT_API_KEY = process.env.RIOT_API_KEY || ""; // Riot API 키

// ✅ 굴뚝딱가리 관련 모든 명령어 허용 채널 (내전-모집 채널)
const ALLOWED_CHANNEL_ID = "1439215856440578078";

// ===============================
// KST 날짜 처리 유틸 (수동 모집 여부 체크용)
// ===============================
let lastManualRecruitDate = null;

function getTodayKSTString() {
  const now = new Date();
  const kstString = now.toLocaleString("en-US", { timeZone: "Asia/Seoul" });
  const kst = new Date(kstString);

  const y = kst.getFullYear();
  const m = String(kst.getMonth() + 1).padStart(2, "0");
  const d = String(kst.getDate()).padStart(2, "0");

  return `${y}-${m}-${d}`;
}

// ===============================
// Discord Client
// ===============================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// ===============================
// Google Sheets
// ===============================
let googleAuthOptions;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  googleAuthOptions = {
    credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  };
} else {
  googleAuthOptions = {
    keyFile: "./credentials.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  };
}

const auth = new google.auth.GoogleAuth(googleAuthOptions);
const sheets = new google.sheets({ version: "v4", auth });

const SHEET_NAME = "대진표";
const RANGE_10P = `${SHEET_NAME}!L5:L14`;
const RANGE_20P = `${SHEET_NAME}!L18:L37`;

// 참가/대기자 팀 배치 정보 등 초기화용 추가 범위
const RANGE_TEAM_10 = `${SHEET_NAME}!E4:I5`;
const RANGE_TEAM_20 = `${SHEET_NAME}!E18:I21`;

// ===============================
// Riot Tournament (stub) 설정
// ===============================
// 지금은 stub 엔드포인트(테스트용) 사용 중.
// Tournament API 승인이 나면 아래 BASE_URL을
//   "https://asia.api.riotgames.com/lol/tournament/v5"
// 로 바꾸고, 승인된 Production API Key를 RIOT_API_KEY에 넣어주면 됨.
const RIOT_BASE_URL =
  "https://asia.api.riotgames.com/lol/tournament-stub/v5";

const riot = axios.create({
  baseURL: RIOT_BASE_URL,
  headers: {
    "X-Riot-Token": RIOT_API_KEY,
    "Content-Type": "application/json"
  }
});

// provider 생성
async function createProvider() {
  const body = {
    region: "KR",
    url: "https://example.com/callback" // stub라서 아무 URL이나 상관없음
  };
  const res = await riot.post("/providers", body);
  return res.data; // providerId
}

// tournament 생성
async function createTournament(providerId) {
  const body = {
    name: "Gulttuk Inhouse BO3",
    providerId
  };
  const res = await riot.post("/tournaments", body);
  return res.data; // tournamentId
}

// BO3용 코드 3개 생성
async function createBo3Codes(tournamentId, metadata) {
  const params = {
    count: 3,
    tournamentId
  };
  const body = {
    mapType: "SUMMONERS_RIFT",
    pickType: "TOURNAMENT_DRAFT",
    spectatorType: "ALL",
    teamSize: 5,
    metadata: metadata ?? "gulttuk-inhouse-bo3"
  };
  const res = await riot.post("/codes", body, { params });
  return res.data; // ["KR-XXXX", "KR-YYYY", "KR-ZZZZ"]
}

// /내전코드에서 한 번에 호출하는 함수
async function generateInhouseBo3Codes(meta) {
  if (!RIOT_API_KEY) {
    // 키 자체를 못 읽은 경우
    throw new Error("NO_KEY");
  }

  try {
    const providerId = await createProvider();
    const tournamentId = await createTournament(providerId);
    const codes = await createBo3Codes(tournamentId, meta);
    return codes;
  } catch (err) {
    if (err.response) {
      console.error("Riot API Error:", err.response.status, err.response.data);
      if (err.response.status === 403) {
        // Tournament API 권한 없음
        throw new Error("FORBIDDEN");
      }
      throw new Error(`RIOT_${err.response.status}`);
    } else {
      console.error("Riot API Error:", err.message);
      throw new Error("RIOT_UNKNOWN");
    }
  }
}

// ===============================
// 데이터 저장소
// ===============================
const signupMessages = new Map();   // 채널별 모집 메시지 ID
const participantsMap = new Map();  // 채널별 참가자 목록(문자열 배열)
const waitlists = new Map();        // 채널별 대기자 목록(문자열 배열)
const modeMap = new Map();          // 채널별 모드("10" | "20")

// 메시지 업데이트 충돌 방지용 Lock
const messageUpdateLock = new Map();

// Sheet Lock (동시 sheet I/O 방지)
let sheetLock = false;

// ===============================
// Lock 유틸
// ===============================
async function acquireLock() {
  while (sheetLock) await new Promise((res) => setTimeout(res, 20));
  sheetLock = true;
}
function releaseLock() {
  sheetLock = false;
}

// ===============================
// Sheets I/O
// ===============================
async function readRange(range) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range
  });
  return res.data.values || [];
}

async function writeRange(range, values) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "RAW",
    requestBody: { values }
  });
}

async function get10pList() {
  return (await readRange(RANGE_10P))
    .map((r) => (r[0] || "").trim())
    .filter(Boolean);
}

async function set10pList(list) {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push([list[i] || ""]);
  await writeRange(RANGE_10P, rows);
}

async function get20pList() {
  return (await readRange(RANGE_20P))
    .map((r) => (r[0] || "").trim())
    .filter(Boolean);
}

async function set20pList(list) {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push([list[i] || ""]);
  await writeRange(RANGE_20P, rows);
}

// ✅ 임의 범위를 전부 빈 값으로 초기화하는 유틸
async function clearRange(range, rows, cols) {
  const values = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) row.push("");
    values.push(row);
  }
  await writeRange(range, values);
}

// 참가자/대기자 관련 전체 시트 초기화 (E4:I5, E18:I21, L5:L14, L18:L37)
async function clearDailySheetAll() {
  await clearRange(RANGE_TEAM_10, 2, 5);   // E4:I5
  await clearRange(RANGE_TEAM_20, 4, 5);   // E18:I21
  await clearRange(RANGE_10P, 10, 1);      // L5:L14
  await clearRange(RANGE_20P, 20, 1);      // L18:L37
}

// 참가자 목록을 시트에 동기화 (버튼 클릭 후 백그라운드에서 호출)
async function syncParticipantsToSheet(channelId) {
  await acquireLock();
  try {
    const mode = getMode(channelId);
    const p = participantsMap.get(channelId) || [];

    if (mode === "10") {
      await set10pList(p);
    } else {
      await set20pList(p);
    }
  } catch (e) {
    console.error("syncParticipantsToSheet error:", e);
  } finally {
    releaseLock();
  }
}

// ===============================
// 모드 & 참가 정보 동기화
// ===============================
function getMode(channelId) {
  return modeMap.get(channelId) || "10";
}

// 명령어/크론에서만 사용 (버튼에서는 더 이상 시트 읽지 않음)
async function syncFromSheet(channelId) {
  const mode = getMode(channelId);

  if (mode === "10") {
    const list10 = await get10pList();
    participantsMap.set(channelId, list10);
    if (!waitlists.has(channelId)) waitlists.set(channelId, []);
  } else {
    const list20 = await get20pList();
    participantsMap.set(channelId, list20);
    if (!waitlists.has(channelId)) waitlists.set(channelId, []);
  }
}

// ===============================
// 이름 처리
// ===============================
function getMemberDisplayName(member) {
  if (!member) return null;
  return member.nickname || member.user.globalName || member.user.username;
}

async function buildDisplayNames(guild, names) {
  if (!guild || !names || !names.length) return names || [];
  const members = await guild.members.fetch().catch(() => null);
  if (!members) return names;

  return names.map((name) => {
    const m = members.find(
      (x) =>
        x.nickname === name ||
        x.user.globalName === name ||
        x.user.username === name
    );
    return m ? getMemberDisplayName(m) : name;
  });
}

// 저장된 이름을 실제 멤버 멘션(<@id>)으로 변환
async function buildMentionsForNames(guild, names) {
  if (!guild || !names || !names.length) return [];
  const members = await guild.members.fetch().catch(() => null);
  if (!members) return names;

  return names.map((name) => {
    const m = members.find(
      (x) =>
        x.nickname === name ||
        x.user.globalName === name ||
        x.user.username === name
    );
    return m ? `<@${m.id}>` : name;
  });
}

// ===============================
// 텍스트 생성
// ===============================
async function buildSignupText(channelId, guild) {
  const mode = getMode(channelId);
  const p = participantsMap.get(channelId) || [];
  const w = waitlists.get(channelId) || [];

  const dp = await buildDisplayNames(guild, p);
  const dw = await buildDisplayNames(guild, w);

  if (mode === "10") {
    let text = "\n⚔️ 오늘 내전 참가하실 분은 아래 버튼을 눌러주세요!\n참가자 10명이 모이면 시작! \n만약 대기자가 많으면 20명 내전 진행\n\n";
    text += `참가자 (${p.length}명):\n${p.length ? dp.join(" ") : "없음"}`;
    if (w.length)
      text += `\n\n대기자 (${w.length}명):\n${dw.join(" ")}`;
    return text;
  }

  let text = "⚔️ 20명 내전 모집중 !! 참가하실 분은 아래 버튼을 눌러주세요!\n\n";
  text += `참가자 (${p.length}명):\n${p.length ? dp.join(" ") : "없음"}`;
  return text;
}

// @everyone 멘션을 앞에 붙이는 헬퍼
function applyEveryonePrefix(text) {
  return `@everyone ${text}`;
}

// ===============================
// 메시지 업데이트 (명령어/크론에서만 사용)
// ===============================
function safeUpdateSignupMessage(channelId) {
  if (!signupMessages.get(channelId)) return;

  if (messageUpdateLock.get(channelId) === true) {
    messageUpdateLock.set(channelId, "queued");
    return;
  }

  messageUpdateLock.set(channelId, true);

  const runUpdate = async () => {
    try {
      const msgId = signupMessages.get(channelId);
      if (!msgId) return;

      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) return;

      const msg = await channel.messages.fetch(msgId).catch(() => null);
      if (!msg) return;

      const baseText = await buildSignupText(channelId, channel.guild);
      const newText = applyEveryonePrefix(baseText);

      await msg.edit({
        content: newText,
        components: msg.components,
        allowedMentions: { parse: ["everyone"] }
      }).catch(() => {});
    } finally {
      if (messageUpdateLock.get(channelId) === "queued") {
        messageUpdateLock.set(channelId, true);
        setTimeout(runUpdate, 50);
      } else {
        messageUpdateLock.set(channelId, false);
      }
    }
  };

  runUpdate();
}

// ===============================
// Ready
// ===============================
client.once("ready", async () => {
  console.log(`로그인 성공: ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName("내전모집")
      .setDescription("내전 참가 버튼 메시지 생성"),
    new SlashCommandBuilder()
      .setName("내전멤버")
      .setDescription("현재 참가자 확인"),
    new SlashCommandBuilder()
      .setName("20")
      .setDescription("20인 모드로 전환"),
    new SlashCommandBuilder()
      .setName("re")
      .setDescription("10인 모드로 전환"),
    new SlashCommandBuilder()
      .setName("시작")
      .setDescription("참가자 소집"),
    new SlashCommandBuilder()
      .setName("굴뚝딱가리")
      .setDescription("윤섭 호출"),
    new SlashCommandBuilder()
      .setName("초기화")
      .setDescription("현재 참가자/대기자 및 시트 명단 초기화"),
    new SlashCommandBuilder() // /내전코드
      .setName("내전코드")
      .setDescription("굴뚝 내전 BO3 토너먼트 코드를 생성합니다.")
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
  try {
    if (GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, GUILD_ID),
        { body: commands }
      );
      console.log("길드 명령어 등록 완료");
    } else {
      await rest.put(Routes.applicationCommands(client.user.id), {
        body: commands
      });
      console.log("글로벌 명령어 등록 완료");
    }
  } catch (e) {
    console.error(e);
  }
});

// ===============================
// interactionCreate
// ===============================
client.on("interactionCreate", async (interaction) => {
  const channelId = interaction.channelId;

  try {
    // ------------------------------
    // Slash Commands
    // ------------------------------
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      // ✅ 굴뚝딱가리 관련 모든 명령어는 내전-모집 채널에서만 사용
      if (channelId !== ALLOWED_CHANNEL_ID) {
        return interaction.reply({
          content: `이 명령어는 <#${ALLOWED_CHANNEL_ID}> 채널에서만 사용할 수 있습니다.`,
          ephemeral: true
        });
      }

      if (!modeMap.has(channelId)) modeMap.set(channelId, "10");
      if (!waitlists.has(channelId)) waitlists.set(channelId, []);

      // /내전코드
      if (commandName === "내전코드") {
        await interaction.deferReply({ ephemeral: false });

        try {
          const meta = `guild:${interaction.guildId},channel:${interaction.channelId},user:${interaction.user.id}`;
          const codes = await generateInhouseBo3Codes(meta);

          if (!Array.isArray(codes) || codes.length < 3) {
            throw new Error("토너먼트 코드가 3개 생성되지 않았습니다.");
          }

          const [game1, game2, game3] = codes;

          const msg =
            "**굴뚝 내전 BO3 토너먼트 코드 생성 완료!**\n" +
            ">>> " +
            `**Game 1** : \`${game1}\`\n` +
            `**Game 2** : \`${game2}\`\n` +
            `**Game 3** : \`${game3}\`\n\n` +
            "**설정**\n" +
            "- 서버: **KR**\n" +
            "- 맵: **소환사의 협곡 (Summoner's Rift)**\n" +
            "- 모드: **토너먼트 드래프트 (Tournament Draft)**\n" +
            "- 팀 구성: **5 vs 5**\n\n" +
            "`롤 클라이언트 > 플레이 > 토너먼트 코드 입력` 메뉴에서 위 코드를 각각 입력하면 됩니다.";

          await interaction.editReply({ content: msg });
        } catch (err) {
          console.error("/내전코드 error:", err);

          let humanMsg =
            "토너먼트 코드 생성 중 오류가 발생했습니다.";

          if (err.message === "NO_KEY") {
            humanMsg =
              "RIOT_API_KEY 환경 변수가 설정되어 있지 않습니다.\nRender 환경 변수에 Riot API 키를 넣어주세요.";
          } else if (err.message === "FORBIDDEN") {
            humanMsg =
              "토너먼트 API에 접근할 권한이 없어 403 Forbidden 오류가 발생했습니다.\n" +
              "- Riot Developer Support에 제출한 Tournament API 요청이 아직 승인되지 않았거나,\n" +
              "- 승인된 Production API Key 대신 일반 Development Key를 사용 중일 수 있습니다.\n\n" +
              "Tournament API 신청이 승인된 후, 해당 키를 RIOT_API_KEY에 넣고 다시 시도해주세요.";
          }

          await interaction.editReply(humanMsg);
        }
        return;
      }

      // /내전모집
      if (commandName === "내전모집") {
        await syncFromSheet(channelId);

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("signup")
            .setLabel("참가")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId("cancel")
            .setLabel("취소")
            .setStyle(ButtonStyle.Danger)
        );

        const baseText = await buildSignupText(channelId, interaction.guild);

        const prevId = signupMessages.get(channelId);
        if (prevId) {
          const prev = await interaction.channel.messages
            .fetch(prevId)
            .catch(() => null);
          if (prev) prev.delete().catch(() => {});
        }

        await interaction.reply({
          content: applyEveryonePrefix(baseText),
          components: [row],
          allowedMentions: { parse: ["everyone"] }
        });

        const sent = await interaction.fetchReply();
        signupMessages.set(channelId, sent.id);

        // ✅ 오늘 수동으로 /내전모집이 실행되었음을 기록 (KST 기준)
        lastManualRecruitDate = getTodayKSTString();
      }

      // /내전멤버
      else if (commandName === "내전멤버") {
        await syncFromSheet(channelId);
        const mode = getMode(channelId);

        const p = participantsMap.get(channelId) || [];
        const w = waitlists.get(channelId) || [];

        const dp = await buildDisplayNames(interaction.guild, p);
        const dw = await buildDisplayNames(interaction.guild, w);

        let t = `현재 모드: ${mode}\n\n`;
        t += `참가자 (${p.length}명):\n${p.length ? dp.join(" ") : "없음"}`;
        if (mode === "10" && w.length)
          t += `\n\n대기자 (${w.length}명):\n${dw.join(" ")}`;

        await interaction.reply({ content: t, ephemeral: true });
      }

      // /20
      else if (commandName === "20") {
        await acquireLock();
        try {
          if (getMode(channelId) === "20")
            return interaction.reply({
              content: "이미 20모드입니다.",
              ephemeral: true
            });

          await syncFromSheet(channelId);
          const p = participantsMap.get(channelId) || [];
          const w = waitlists.get(channelId) || [];

          const merged = [...p, ...w].slice(0, 20);

          await set20pList(merged);
          await set10pList([]);

          modeMap.set(channelId, "20");
          participantsMap.set(channelId, merged);
          waitlists.set(channelId, []);

          await interaction.reply({
            content: "20모드로 전환되었습니다!",
            ephemeral: true
          });
          setTimeout(() => safeUpdateSignupMessage(channelId), 200);
        } finally {
          releaseLock();
        }
      }

      // /re
      else if (commandName === "re") {
        await acquireLock();
        try {
          if (getMode(channelId) === "10")
            return interaction.reply({
              content: "이미 10모드입니다.",
              ephemeral: true
            });

          const list20 = await get20pList();
          const p10 = list20.slice(0, 10);
          const w = list20.slice(10);

          await set10pList(p10);
          await set20pList([]);

          modeMap.set(channelId, "10");
          participantsMap.set(channelId, p10);
          waitlists.set(channelId, w);

          await interaction.reply({
            content: "10모드로 전환되었습니다!",
            ephemeral: true
          });
          setTimeout(() => safeUpdateSignupMessage(channelId), 200);
        } finally {
          releaseLock();
        }
      }

      // /시작 — 실제 멘션 알림
      else if (commandName === "시작") {
        const p = participantsMap.get(channelId) || [];
        if (!p.length) {
          return interaction.reply({
            content: "현재 참가자가 없습니다.",
            ephemeral: true
          });
        }

        const mentions = await buildMentionsForNames(interaction.guild, p);

        await interaction.reply({
          content: `${mentions.join(" ")}\n내전 시작합니다! 모두 모여주세요~`,
          allowedMentions: { parse: ["users"] }
        });
      }

      // /굴뚝딱가리
      else if (commandName === "굴뚝딱가리") {
        const members = await interaction.guild.members
          .fetch()
          .catch(() => null);
        if (!members) {
          return interaction.reply({
            content: "멤버 정보를 불러올 수 없습니다.",
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
            content: "윤섭을 찾을 수 없습니다.",
            ephemeral: true
          });
        }

        return interaction.reply({
          content: `<@${target.id}> 윤섭아 너 부른다.`,
          ephemeral: false
        });
      }

      // /초기화
      else if (commandName === "초기화") {
        await acquireLock();
        try {
          await set10pList([]);
          await set20pList([]);
          participantsMap.set(channelId, []);
          waitlists.set(channelId, []);
        } catch (e) {
          console.error("/초기화 error:", e);
          return interaction.reply({
            content: "초기화 중 오류가 발생했습니다.",
            ephemeral: true
          });
        } finally {
          releaseLock();
        }

        safeUpdateSignupMessage(channelId);

        return interaction.reply({
          content: "현재 참가자/대기자 및 구글 시트 명단을 모두 초기화했습니다.",
          ephemeral: true
        });
      }
    }

    // ------------------------------
    // Button (참가/취소)
    // ------------------------------
    else if (interaction.isButton()) {
      // 1) 바로 ACK
      try {
        await interaction.deferUpdate();
      } catch {
        return;
      }

      // 봇 재시작된 뒤 기존 메시지 버튼을 눌렀을 수도 있으므로,
      // 메모리에 데이터가 없으면 시트에서 한 번 동기화해 온다.
      if (!participantsMap.has(channelId) || !waitlists.has(channelId)) {
        try {
          await syncFromSheet(channelId);
        } catch (e) {
          console.error("버튼 처리 중 시트 동기화 오류:", e);
          if (!participantsMap.has(channelId)) participantsMap.set(channelId, []);
          if (!waitlists.has(channelId)) waitlists.set(channelId, []);
        }
        if (!waitlists.has(channelId)) waitlists.set(channelId, []);
      }

      let replyText = "";
      let needUpdate = false;

      const mode = getMode(channelId);
      const p = participantsMap.get(channelId) || [];
      const w = waitlists.get(channelId) || [];

      const member = interaction.member;
      const userName = getMemberDisplayName(member);

      if (!userName) {
        replyText = "사용자 정보를 불러올 수 없습니다.";
      } else {
        if (interaction.customId === "signup") {
          if (p.includes(userName) || w.includes(userName)) {
            replyText = "이미 신청한 상태입니다.";
          } else {
            if (mode === "10") {
              if (p.length < 10) {
                p.push(userName);
                replyText = "참가 완료!";
              } else {
                w.push(userName);
                replyText = "정원 초과로 대기자로 등록되었습니다.";
              }
            } else {
              if (p.length >= 20) {
                replyText = "20명 정원이 가득 찼습니다.";
              } else {
                p.push(userName);
                replyText = "참가 완료!";
              }
            }
            needUpdate = true;
          }
        } else if (interaction.customId === "cancel") {
          const oldP = p.length;
          const oldW = w.length;

          const idxP = p.indexOf(userName);
          if (idxP !== -1) p.splice(idxP, 1);
          const idxW = w.indexOf(userName);
          if (idxW !== -1) w.splice(idxW, 1);

          if (p.length === oldP && w.length === oldW) {
            replyText = "신청 기록이 없습니다.";
          } else {
            if (mode === "10") {
              if (p.length < 10 && w.length > 0) {
                const moved = w.shift();
                if (moved) p.push(moved);
              }
            }
            replyText = "신청이 취소되었습니다!";
            needUpdate = true;
          }
        }
      }

      participantsMap.set(channelId, p);
      waitlists.set(channelId, w);

      // 3) 모집 메시지 내용 갱신
      if (needUpdate) {
        try {
          const baseText = await buildSignupText(channelId, interaction.guild);
          await interaction.message.edit({
            content: applyEveryonePrefix(baseText),
            components: interaction.message.components,
            allowedMentions: { parse: ["everyone"] }
          });
        } catch (e) {
          console.error("button message.edit error:", e);
        }
        syncParticipantsToSheet(channelId).catch(() => {});
      }

      // 4) 에페메랄 안내
      try {
        await interaction.followUp({
          content: replyText || "처리 중 오류가 발생했습니다.",
          ephemeral: true
        });
      } catch (e) {
        console.error("button followUp error:", e);
      }
    }
  } catch (e) {
    console.error("interactionCreate error:", e);
  }
});

// ===============================
// 매일 오전 8시 — 참가/대기자 + 시트 정보 초기화
// ===============================
cron.schedule(
  "0 8 * * *",
  async () => {
    try {
      const channelId = CHANNEL_ID;
      if (!channelId) return;

      await acquireLock();
      try {
        // 메모리 상 참가자/대기자 초기화
        participantsMap.set(channelId, []);
        waitlists.set(channelId, []);
        // 구글 시트 관련 범위 전체 초기화
        await clearDailySheetAll();
      } finally {
        releaseLock();
      }

      // 기존 모집 메시지가 있다면 내용만 "빈 상태"로 갱신 (알림/멘션 없음)
      const msgId = signupMessages.get(channelId);
      if (!msgId) return;

      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) return;

      const msg = await channel.messages.fetch(msgId).catch(() => null);
      if (!msg) return;

      const baseText = await buildSignupText(channelId, channel.guild);
      await msg
        .edit({
          content: baseText,
          components: msg.components,
          allowedMentions: { parse: [] } // @everyone 멘션 안 날리도록
        })
        .catch(() => {});
    } catch (e) {
      console.error("08시 자동 초기화 실패:", e);
    }
  },
  { timezone: "Asia/Seoul" }
);

// ===============================
// 자동 모집 (매일 17시)
// ===============================
cron.schedule(
  "0 17 * * *",
  async () => {
    try {
      const channelId = CHANNEL_ID;
      if (!channelId) return;

      // ✅ 오늘 이미 수동으로 /내전모집을 쓴 경우 자동 모집 건너뜀
      const todayKST = getTodayKSTString();
      if (lastManualRecruitDate === todayKST) {
        console.log(
          "[자동 모집] 오늘 이미 수동 /내전모집이 실행되어 자동 모집을 건너뜁니다."
        );
        return;
      }

      await acquireLock();
      try {
        modeMap.set(channelId, "10");
        await set10pList([]);
        await set20pList([]);
        participantsMap.set(channelId, []);
        waitlists.set(channelId, []);
      } finally {
        releaseLock();
      }

      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) return;

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("signup")
          .setLabel("참가")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId("cancel")
          .setLabel("취소")
          .setStyle(ButtonStyle.Danger)
      );

      const baseText = await buildSignupText(channelId, channel.guild);

      const prevId = signupMessages.get(channelId);
      if (prevId) {
        const prev = await channel.messages.fetch(prevId).catch(() => null);
        if (prev) prev.delete().catch(() => {});
      }

      const msg = await channel.send({
        content: applyEveryonePrefix(baseText),
        components: [row],
        allowedMentions: { parse: ["everyone"] }
      });

      signupMessages.set(channelId, msg.id);
    } catch (e) {
      console.error("자동 모집 실패:", e);
    }
  },
  { timezone: "Asia/Seoul" }
);

// ===============================
// 로그인
// ===============================
client.login(BOT_TOKEN);

// ===============================
// HTTP Server (Render Ping)
// ===============================
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Bot is running\n");
  })
  .listen(PORT, () => console.log(`HTTP server on ${PORT}`));
