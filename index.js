// ===============================
// 굴뚝 내전 봇 index.js
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

const axios = require("axios");
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
const RIOT_API_KEY = process.env.RIOT_API_KEY || "";

// ✅ 내전 관련 명령어 허용 채널
const ALLOWED_CHANNEL_ID = "1439215856440578078";

// ===============================
// KST 날짜 유틸 (자동 모집 중복 방지용)
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
const RANGE_TEAM_10 = `${SHEET_NAME}!E4:I5`;
const RANGE_TEAM_20 = `${SHEET_NAME}!E18:I21`;
const RANGE_LAST_MANUAL = `${SHEET_NAME}!Z1`; // 수동 /내전모집 날짜 저장

// ===============================
// Riot Tournament Stub 설정
// ===============================
const RIOT_BASE_URL =
  "https://asia.api.riotgames.com/lol/tournament-stub/v5";

const riot = axios.create({
  baseURL: RIOT_BASE_URL,
  headers: {
    "X-Riot-Token": RIOT_API_KEY,
    "Content-Type": "application/json"
  }
});

async function createProvider() {
  const body = {
    region: "KR",
    url: "https://example.com/callback"
  };
  const res = await riot.post("/providers", body);
  return res.data;
}

async function createTournament(providerId) {
  const body = {
    name: "Gulttuk Inhouse BO3",
    providerId
  };
  const res = await riot.post("/tournaments", body);
  return res.data;
}

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
  return res.data;
}

async function generateInhouseBo3Codes(meta) {
  if (!RIOT_API_KEY) {
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
const participantsMap = new Map();  // 채널별 참가자 배열
const waitlists = new Map();        // 채널별 대기자 배열
const modeMap = new Map();          // 채널별 모드("10" | "20")
const messageUpdateLock = new Map();// 메시지 업데이트 락
const signupHeaderMap = new Map();  // 채널별 헤더 문구

// 라인 배치 정보 (채널별)
// { mode: "10"|"20", top:[], jg:[], mid:[], adc:[], sup:[] }
const laneMap = new Map();

// Sheet I/O Lock
let sheetLock = false;

// ===============================
// Lock 유틸
// ===============================
async function acquireLock() {
  while (sheetLock) {
    await new Promise((res) => setTimeout(res, 20));
  }
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

async function clearRange(range, rows, cols) {
  const values = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) row.push("");
    values.push(row);
  }
  await writeRange(range, values);
}

async function clearDailySheetAll() {
  await clearRange(RANGE_TEAM_10, 2, 5);
  await clearRange(RANGE_TEAM_20, 4, 5);
  await clearRange(RANGE_10P, 10, 1);
  await clearRange(RANGE_20P, 20, 1);
}

// lane helpers (10모드)
async function getLane10FromSheet() {
  const vals = await readRange(RANGE_TEAM_10); // 2 x 5
  const r0 = (vals[0] || []);
  const r1 = (vals[1] || []);
  const get = (row, idx) => (row[idx] || "").trim();
  return {
    mode: "10",
    top: [get(r0, 0), get(r1, 0)],
    jg:  [get(r0, 1), get(r1, 1)],
    mid: [get(r0, 2), get(r1, 2)],
    adc: [get(r0, 3), get(r1, 3)],
    sup: [get(r0, 4), get(r1, 4)]
  };
}

async function setLane10ToSheet(lane) {
  const rows = [
    [
      lane.top[0] || "",
      lane.jg[0] || "",
      lane.mid[0] || "",
      lane.adc[0] || "",
      lane.sup[0] || ""
    ],
    [
      lane.top[1] || "",
      lane.jg[1] || "",
      lane.mid[1] || "",
      lane.adc[1] || "",
      lane.sup[1] || ""
    ]
  ];
  await writeRange(RANGE_TEAM_10, rows);
}

// lane helpers (20모드)
async function getLane20FromSheet() {
  const vals = await readRange(RANGE_TEAM_20); // 4 x 5
  const r = [];
  for (let i = 0; i < 4; i++) r.push(vals[i] || []);
  const get = (row, idx) => (row[idx] || "").trim();
  return {
    mode: "20",
    top: [get(r[0], 0), get(r[1], 0), get(r[2], 0), get(r[3], 0)],
    jg:  [get(r[0], 1), get(r[1], 1), get(r[2], 1), get(r[3], 1)],
    mid: [get(r[0], 2), get(r[1], 2), get(r[2], 2), get(r[3], 2)],
    adc: [get(r[0], 3), get(r[1], 3), get(r[2], 3), get(r[3], 3)],
    sup: [get(r[0], 4), get(r[1], 4), get(r[2], 4), get(r[3], 4)]
  };
}

async function setLane20ToSheet(lane) {
  const rows = [
    [
      lane.top[0] || "",
      lane.jg[0] || "",
      lane.mid[0] || "",
      lane.adc[0] || "",
      lane.sup[0] || ""
    ],
    [
      lane.top[1] || "",
      lane.jg[1] || "",
      lane.mid[1] || "",
      lane.adc[1] || "",
      lane.sup[1] || ""
    ],
    [
      lane.top[2] || "",
      lane.jg[2] || "",
      lane.mid[2] || "",
      lane.adc[2] || "",
      lane.sup[2] || ""
    ],
    [
      lane.top[3] || "",
      lane.jg[3] || "",
      lane.mid[3] || "",
      lane.adc[3] || "",
      lane.sup[3] || ""
    ]
  ];
  await writeRange(RANGE_TEAM_20, rows);
}

// ✅ 수동 /내전모집 날짜 시트에서 읽기
async function getLastManualRecruitDateFromSheet() {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: RANGE_LAST_MANUAL
    });
    const values = res.data.values || [];
    if (values[0] && values[0][0]) {
      return String(values[0][0]).trim();
    }
    return null;
  } catch (e) {
    console.error("getLastManualRecruitDateFromSheet error:", e);
    return null;
  }
}

// ✅ 오늘 날짜를 시트에 기록 + 메모리에 반영
async function setLastManualRecruitDateToToday() {
  const today = getTodayKSTString();
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: RANGE_LAST_MANUAL,
      valueInputOption: "RAW",
      requestBody: { values: [[today]] }
    });
  } catch (e) {
    console.error("setLastManualRecruitDateToToday error:", e);
  }
  lastManualRecruitDate = today;
}

// 참가자 + 라인 정보를 시트에 동기화
async function syncAllToSheet(channelId) {
  await acquireLock();
  try {
    const mode = getMode(channelId);
    const p = participantsMap.get(channelId) || [];
    const lane = getLaneState(channelId);

    if (mode === "10") {
      await set10pList(p);
      await setLane10ToSheet(lane);
    } else {
      await set20pList(p);
      await setLane20ToSheet(lane);
    }
  } catch (e) {
    console.error("syncAllToSheet error:", e);
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

// lane 기본 상태 생성
function createEmptyLaneState(mode) {
  const cap = mode === "10" ? 2 : 4;
  const make = () => Array(cap).fill("");
  return {
    mode,
    top: make(),
    jg: make(),
    mid: make(),
    adc: make(),
    sup: make()
  };
}

// lane 상태 가져오기 (없으면 생성)
function getLaneState(channelId) {
  const mode = getMode(channelId);
  let st = laneMap.get(channelId);
  const needNew = !st || st.mode !== mode;
  if (needNew) {
    st = createEmptyLaneState(mode);
    laneMap.set(channelId, st);
  }
  return st;
}

// 시트 → 메모리 동기화
async function syncFromSheet(channelId) {
  const mode = getMode(channelId);

  if (mode === "10") {
    const list10 = await get10pList();
    const lane10 = await getLane10FromSheet();
    participantsMap.set(channelId, list10);
    laneMap.set(channelId, lane10);
    if (!waitlists.has(channelId)) waitlists.set(channelId, []);
  } else {
    const list20 = await get20pList();
    const lane20 = await getLane20FromSheet();
    participantsMap.set(channelId, list20);
    laneMap.set(channelId, lane20);
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
// 헤더 문구 유틸
// ===============================
function getDefaultHeaderForMode(mode) {
  if (mode === "10") {
    return (
      "⚔️ 오늘 내전 모집합니다~~ ⚔️\n" +
      "참가자 10명이 모이면 시작!\n" +
      "만약 대기자가 많으면 20명 내전 진행"
    );
  }
  // 20 모드 기본 헤더
  return "⚔️ 오늘 20명 내전 모집합니다~~ ⚔️";
}

function getHeaderForChannel(channelId, mode) {
  const saved = signupHeaderMap.get(channelId);
  if (saved) return saved;
  return getDefaultHeaderForMode(mode);
}

// "0" → "0시~1시" 일반화 (0~23 대응)
function getTimeRangeLabel(raw) {
  if (raw === null || raw === undefined) return null;
  const hour = parseInt(raw, 10);
  if (Number.isNaN(hour)) return null;
  const next = (hour + 1) % 24;
  return `${hour}시~${next}시`;
}

// ===============================
// 텍스트 생성
// ===============================
function joinSlots(arr) {
  return arr.map((x) => x || "").join(" / ");
}

async function buildSignupText(channelId, guild) {
  const mode = getMode(channelId);
  const p = participantsMap.get(channelId) || [];
  const w = waitlists.get(channelId) || [];
  const lane = getLaneState(channelId);

  const dp = await buildDisplayNames(guild, p);
  const dw = await buildDisplayNames(guild, w);

  const header = getHeaderForChannel(channelId, mode);

  let text = `${header}\n\n`;

  // 라인 표시
  text += `탑 : ${joinSlots(lane.top)}\n`;
  text += `정글 : ${joinSlots(lane.jg)}\n`;
  text += `미드 : ${joinSlots(lane.mid)}\n`;
  text += `원딜 : ${joinSlots(lane.adc)}\n`;
  text += `서폿 : ${joinSlots(lane.sup)}\n\n`;

  // 참가자/대기자 블록은 항상 제일 아래
  text += `참가자 (${p.length}명):\n${p.length ? dp.join(" ") : "없음"}`;
  text += `\n\n대기자 (${w.length}명):\n${w.length ? dw.join(" ") : "없음"}`;

  return text;
}

// @everyone 붙이는 헬퍼 (멘션 후 줄바꿈)
function applyEveryonePrefix(text) {
  return `@everyone\n${text}`;
}

// ===============================
// 버튼 컴포넌트 생성
// ===============================
function createLaneButtons() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("lane_top")
      .setLabel("탑")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("lane_jg")
      .setLabel("정글")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("lane_mid")
      .setLabel("미드")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("lane_adc")
      .setLabel("원딜")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("lane_sup")
      .setLabel("서폿")
      .setStyle(ButtonStyle.Primary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("lane_any")
      .setLabel("라인 상관 없음")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("cancel")
      .setLabel("취소")
      .setStyle(ButtonStyle.Danger)
  );

  return [row1, row2];
}

// ===============================
// 모집 메시지 업데이트 (명령어 / 크론에서 사용)
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

      await msg
        .edit({
          content: newText,
          components: msg.components,
          allowedMentions: { parse: ["everyone"] }
        })
        .catch(() => {});
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

  const timeChoices = [];
  for (let h = 0; h <= 12; h++) {
    timeChoices.push({ name: `${h}시`, value: String(h) });
  }

  const commands = [
    new SlashCommandBuilder()
      .setName("내전모집")
      .setDescription("내전 참가 버튼 메시지 생성")
      .addStringOption((option) => {
        let opt = option
          .setName("time")
          .setDescription("내전 시작 시간 (0시~12시)")
          .setRequired(false);
        timeChoices.forEach((c) => (opt = opt.addChoices(c)));
        return opt;
      }),
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
    new SlashCommandBuilder()
      .setName("내전코드")
      .setDescription("굴뚝 내전 BO3 토너먼트 코드를 생성합니다."),
    new SlashCommandBuilder() // /헬프
      .setName("헬프")
      .setDescription("내전 인원이 없을 때 사람을 불러 모읍니다.")
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

      // 내전 관련 채널 제한
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

        const mode = getMode(channelId);
        const inputTime = interaction.options.getString("time");
        const timeRange = inputTime ? getTimeRangeLabel(inputTime) : null;

        if (timeRange) {
          if (mode === "10") {
            const header =
              `⚔️ ${timeRange} 내전 모집합니다~~ ⚔️\n` +
              "참가자 10명이 모이면 시작!\n" +
              "만약 대기자가 많으면 20명 내전 진행";
            signupHeaderMap.set(channelId, header);
          } else {
            const header = `⚔️ ${timeRange} 20명 내전 모집합니다~~ ⚔️`;
            signupHeaderMap.set(channelId, header);
          }
        } else {
          signupHeaderMap.set(
            channelId,
            getDefaultHeaderForMode(mode)
          );
        }

        // 라인 상태 초기화 (새 모집 시작 시)
        laneMap.set(channelId, createEmptyLaneState(mode));

        const components = createLaneButtons();
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
          components,
          allowedMentions: { parse: ["everyone"] }
        });

        const sent = await interaction.fetchReply();
        signupMessages.set(channelId, sent.id);

        // 오늘 수동 /내전모집 실행 기록
        setLastManualRecruitDateToToday().catch(() => {});
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
        t += `\n\n대기자 (${w.length}명):\n${w.length ? dw.join(" ") : "없음"}`;

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

          // 참가자 목록은 기존 로직대로 20명까지로 합치기
          await syncFromSheet(channelId);
          const p = participantsMap.get(channelId) || [];
          const w = waitlists.get(channelId) || [];

          const merged = [...p, ...w].slice(0, 20);

          await set20pList(merged);
          await set10pList([]);

          modeMap.set(channelId, "20");
          participantsMap.set(channelId, merged);
          waitlists.set(channelId, []);

          // 20모드 라인/헤더 초기화
          const emptyLane = createEmptyLaneState("20");
          laneMap.set(channelId, emptyLane);
          await setLane20ToSheet(emptyLane);
          signupHeaderMap.set(channelId, getDefaultHeaderForMode("20"));

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

          const emptyLane = createEmptyLaneState("10");
          laneMap.set(channelId, emptyLane);
          await setLane10ToSheet(emptyLane);
          signupHeaderMap.set(channelId, getDefaultHeaderForMode("10"));

          await interaction.reply({
            content: "10모드로 전환되었습니다!",
            ephemeral: true
          });
          setTimeout(() => safeUpdateSignupMessage(channelId), 200);
        } finally {
          releaseLock();
        }
      }

      // /시작
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
          await clearDailySheetAll();
          participantsMap.set(channelId, []);
          waitlists.set(channelId, []);
          laneMap.set(channelId, createEmptyLaneState(getMode(channelId)));
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

      // /헬프
      else if (commandName === "헬프") {
        return interaction.reply({
          content:
            "@everyone 내전 사람이 없어요 아무나 아는 사람 좀 불러주세요~~",
          allowedMentions: { parse: ["everyone"] }
        });
      }
    }

    // ------------------------------
    // Button (라인/취소)
// ------------------------------
    else if (interaction.isButton()) {
      try {
        await interaction.deferUpdate();
      } catch {
        return;
      }

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
      const cap = mode === "10" ? 10 : 20;

      const p = participantsMap.get(channelId) || [];
      const w = waitlists.get(channelId) || [];
      const lane = getLaneState(channelId);

      const member = interaction.member;
      const userName = getMemberDisplayName(member);

      if (!userName) {
        replyText = "사용자 정보를 불러올 수 없습니다.";
      } else {
        const id = interaction.customId;

        // 취소 버튼
        if (id === "cancel") {
          const oldP = p.length;
          const oldW = w.length;

          // 참가자/대기자 제거
          const idxP = p.indexOf(userName);
          if (idxP !== -1) p.splice(idxP, 1);
          const idxW = w.indexOf(userName);
          if (idxW !== -1) w.splice(idxW, 1);

          // 라인에서 제거
          ["top", "jg", "mid", "adc", "sup"].forEach((key) => {
            const arr = lane[key];
            for (let i = 0; i < arr.length; i++) {
              if (arr[i] === userName) arr[i] = "";
            }
          });

          if (p.length === oldP && w.length === oldW) {
            replyText = "신청 기록이 없습니다.";
          } else {
            // 정원 여유가 있고 대기자가 있다면 1명 승급 (라인은 비워둠)
            if (p.length < cap && w.length > 0) {
              const moved = w.shift();
              if (moved) p.push(moved);
            }
            replyText = "신청이 취소되었습니다!";
            needUpdate = true;
          }
        }
        // 라인/라인 상관없음 버튼
        else if (id.startsWith("lane_")) {
          const laneKey = id.replace("lane_", ""); // top/jg/mid/adc/sup/any
          const isParticipant = p.includes(userName);
          const isWait = w.includes(userName);

          const removeFromAllLanes = () => {
            ["top", "jg", "mid", "adc", "sup"].forEach((key) => {
              const arr = lane[key];
              for (let i = 0; i < arr.length; i++) {
                if (arr[i] === userName) arr[i] = "";
              }
            });
          };

          // 대기자만인 경우: 라인 선택 불가
          if (!isParticipant && isWait) {
            replyText = "대기자는 라인을 선택할 수 없습니다.";
          } else if (laneKey === "any") {
            // 라인 상관 없음
            if (!isParticipant && !isWait) {
              // 새 유저
              if (p.length >= cap) {
                w.push(userName);
                replyText = "정원 초과로 대기자로 등록되었습니다.";
              } else {
                p.push(userName);
                replyText = "참가 완료!";
              }
              needUpdate = true;
            } else {
              // 이미 참가자인 경우: 라인만 비우고 참가 상태 유지
              removeFromAllLanes();
              replyText = "라인 설정이 해제되었습니다. (라인 상관 없음)";
              needUpdate = true;
            }
          } else {
            // 특정 라인
            const laneLabelMap = {
              top: "탑",
              jg: "정글",
              mid: "미드",
              adc: "원딜",
              sup: "서폿"
            };
            const arr = lane[laneKey];

            if (!isParticipant && !isWait) {
              // 완전 신규
              if (p.length >= cap) {
                w.push(userName);
                replyText = "정원 초과로 대기자로 등록되었습니다.";
                needUpdate = true;
              } else {
                const emptyIdx = arr.findIndex((x) => !x);
                if (emptyIdx === -1) {
                  replyText = `${laneLabelMap[laneKey]} 자리가 가득 찼습니다. 다른 라인을 선택해주세요.`;
                } else {
                  arr[emptyIdx] = userName;
                  p.push(userName);
                  replyText = "참가 완료!";
                  needUpdate = true;
                }
              }
            } else if (isParticipant) {
              // 이미 참가자인 경우: 라인 변경 또는 배정
              const emptyIdx = arr.findIndex((x) => !x);
              if (arr.some((n) => n === userName)) {
                replyText = "이미 해당 라인에 배정되어 있습니다.";
              } else if (emptyIdx === -1) {
                replyText = `${laneLabelMap[laneKey]} 자리가 가득 찼습니다. 다른 라인을 선택해주세요.`;
              } else {
                // 기존 라인에서 제거 후 새 라인에 배정
                removeFromAllLanes();
                arr[emptyIdx] = userName;
                replyText = "라인이 변경되었습니다.";
                needUpdate = true;
              }
            } else {
              // 이 외의 이상 상태는 그냥 막아둠
              replyText = "이미 신청한 상태입니다.";
            }
          }
        }
      }

      participantsMap.set(channelId, p);
      waitlists.set(channelId, w);
      laneMap.set(channelId, lane);

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
        syncAllToSheet(channelId).catch(() => {});
      }

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
        participantsMap.set(channelId, []);
        waitlists.set(channelId, []);
        laneMap.set(channelId, createEmptyLaneState(getMode(channelId)));
        await clearDailySheetAll();
      } finally {
        releaseLock();
      }

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
          allowedMentions: { parse: [] } // 8시 초기화는 everyone 안 날림
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

      const todayKST = getTodayKSTString();

      const sheetDate = await getLastManualRecruitDateFromSheet();
      if (sheetDate) {
        lastManualRecruitDate = sheetDate;
      }

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
        const emptyLane10 = createEmptyLaneState("10");
        laneMap.set(channelId, emptyLane10);
        await setLane10ToSheet(emptyLane10);
        participantsMap.set(channelId, []);
        waitlists.set(channelId, []);
      } finally {
        releaseLock();
      }

      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) return;

      const components = createLaneButtons();
      signupHeaderMap.set(channelId, getDefaultHeaderForMode("10"));

      const baseText = await buildSignupText(channelId, channel.guild);

      const prevId = signupMessages.get(channelId);
      if (prevId) {
        const prev = await channel.messages.fetch(prevId).catch(() => null);
        if (prev) prev.delete().catch(() => {});
      }

      const msg = await channel.send({
        content: applyEveryonePrefix(baseText),
        components,
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
