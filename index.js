// ===============================
// 굴뚝 내전 봇 index.js
// - 10모드: 참가자 10명(시트 L5:L14) + 대기자(메모리)
// - 20모드: 참가자 전원 20명 명단(시트 L18:L37), 10명 명단 사용 X
// - /20 : 10모드 상태에서 참가+대기자를 20명 명단으로 옮기고 20모드 진입
// - /re : 20명 명단을 다시 참가10 + 대기자로 되돌리고 10모드 복귀
// ===============================

require("dotenv").config();
const fs = require("fs");

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
const { google } = require("googleapis");
const cron = require("node-cron");
const config = require("./config.json");

const BOT_TOKEN = process.env.TOKEN;

// Render 등 서버 환경에서 GOOGLE_CREDENTIALS 환경변수로 전달된
// credentials.json 내용을 /tmp/credentials.json 파일로 저장
if (process.env.GOOGLE_CREDENTIALS && !fs.existsSync("/tmp/credentials.json")) {
  fs.writeFileSync("/tmp/credentials.json", process.env.GOOGLE_CREDENTIALS);
}

// --------- 디스코드 클라이언트 ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// --------- 구글 시트 인증 ----------
const auth = new google.auth.GoogleAuth({
  keyFile: "/tmp/credentials.json",
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});
const sheets = google.sheets({ version: "v4", auth });

// 시트 정보
const SHEET_NAME = "대진표";
const RANGE_10P = `${SHEET_NAME}!L5:L14`;   // 참가 10명
const RANGE_20P = `${SHEET_NAME}!L18:L37`;  // 20명 명단

// 참가 메시지 ID (채널별)
const signupMessages = new Map();

// 채널별 대기자 목록 (10모드에서만 사용)
const waitlists = new Map(); // key: channelId, value: [대기자1, 대기자2, ...]

// 채널별 모드 (10 또는 20)
const modeMap = new Map(); // key: channelId, value: "10" | "20"

// ===== 간단한 Lock (동시 처리 방지) =====
let sheetLock = false;

async function acquireLock() {
  while (sheetLock) {
    await new Promise(res => setTimeout(res, 50));
  }
  sheetLock = true;
}
function releaseLock() {
  sheetLock = false;
}

// ===============================
// 봇 준비 완료
// ===============================
client.once("ready", async () => {
  console.log(`로그인 성공: ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName("내전모집")
      .setDescription("참가/취소 버튼 메시지를 전송합니다.")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("내전멤버")
      .setDescription("현재 내전에 참가한 사람들과 대기자를 보여줍니다.")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("20")
      .setDescription("참가자 + 대기자를 20명 명단에 순서대로 기록하고 20모드로 전환합니다.")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("re")
      .setDescription("20명 명단에서 다시 참가자10 + 대기자로 되돌립니다.")
      .toJSON()
  ];

  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);

  if (config.GUILD_ID) {
    await rest.put(
      Routes.applicationGuildCommands(
        client.user.id,
        config.GUILD_ID
      ),
      { body: commands }
    );
    console.log("길드 슬래시 명령어 등록 완료!");
  } else {
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands
    });
    console.log("글로벌 슬래시 명령어 등록 완료!");
  }
});

// ===============================
// 유틸 함수: 시트 읽기/쓰기
// ===============================
async function readRange(range) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID || config.SHEET_ID,
    range
  });
  return res.data.values || [];
}

async function writeRange(range, values) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.SHEET_ID || config.SHEET_ID,
    range,
    valueInputOption: "RAW",
    requestBody: {
      values
    }
  });
}

// 10명 명단 읽기
async function get10pList() {
  const values = await readRange(RANGE_10P);
  return values.map(row => row[0] || "").filter(Boolean);
}

// 20명 명단 읽기
async function get20pList() {
  const values = await readRange(RANGE_20P);
  return values.map(row => row[0] || "").filter(Boolean);
}

// 10명 명단 쓰기
async function set10pList(names) {
  const rows = [];
  for (let i = 0; i < 10; i++) {
    rows.push([names[i] || ""]);
  }
  await writeRange(RANGE_10P, rows);
}

// 20명 명단 쓰기
async function set20pList(names) {
  const rows = [];
  for (let i = 0; i < 20; i++) {
    rows.push([names[i] || ""]);
  }
  await writeRange(RANGE_20P, rows);
}

// 모드 가져오기
function getMode(channelId) {
  return modeMap.get(channelId) || "10";
}

// 참가/대기자 메시지 텍스트 생성
function buildSignupText(channelId) {
  const mode = getMode(channelId);

  if (mode === "10") {
    const participants = signupCache.get(channelId) || [];
    const wait = waitlists.get(channelId) || [];

    let text = "📢 오늘 굴뚝 내전 참가하실 분은 아래 버튼을 눌러주세요!\n\n";
    text += `현재 참가자 (${participants.length}명):\n`;
    text += participants.length > 0 ? participants.join(" ") : "없음";

    if (wait.length > 0) {
      text += `\n\n대기자 (${wait.length}명):\n${wait.join(" ")}`;
    }

    return text;
  } else {
    const list20 = signupCache.get(channelId) || [];
    let text = "📢 20명 내전 모집중! 아래 버튼을 눌러주세요!\n\n";
    text += `현재 참가자 (${list20.length}명):\n`;
    text += list20.length > 0 ? list20.join(" ") : "없음";
    return text;
  }
}

// 메모리 캐시: 채널별 참가/대기자
const signupCache = new Map();

// 시트 상태를 메모리로 동기화
async function syncFromSheet(channelId) {
  const mode = getMode(channelId);

  if (mode === "10") {
    const current10 = await get10pList();
    signupCache.set(channelId, current10);
    // 대기자는 시트에 안 쓰고 메모리에만
  } else {
    const current20 = await get20pList();
    signupCache.set(channelId, current20);
    waitlists.set(channelId, []);
  }
}

// ===============================
// 슬래시 명령어 처리
// ===============================
client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      if (commandName === "내전모집") {
        const channelId = interaction.channelId;
        if (!modeMap.has(channelId)) {
          modeMap.set(channelId, "10");
        }
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

        const text = buildSignupText(channelId);

        const msg = await interaction.reply({
          content: text,
          components: [row],
          fetchReply: true
        });

        signupMessages.set(channelId, msg.id);
      }

      else if (commandName === "내전멤버") {
        const channelId = interaction.channelId;
        await syncFromSheet(channelId);

        const mode = getMode(channelId);
        const participants = signupCache.get(channelId) || [];
        const wait = waitlists.get(channelId) || [];

        let text = `현재 모드: ${mode === "10" ? "10인 내전" : "20인 내전"}\n`;
        text += `\n참가자 (${participants.length}명):\n`;
        text += participants.length > 0 ? participants.join(" ") : "없음";

        if (mode === "10" && wait.length > 0) {
          text += `\n\n대기자 (${wait.length}명):\n${wait.join(" ")}`;
        }

        await interaction.reply({ content: text, ephemeral: true });
      }

      else if (commandName === "20") {
        const channelId = interaction.channelId;
        await acquireLock();
        try {
          const mode = getMode(channelId);
          if (mode === "20") {
            await interaction.reply({
              content: "이미 20모드입니다.",
              ephemeral: true
            });
            return;
          }

          const participants = signupCache.get(channelId) || [];
          const wait = waitlists.get(channelId) || [];

          const merged = [...participants, ...wait].slice(0, 20);
          await set20pList(merged);

          modeMap.set(channelId, "20");
          signupCache.set(channelId, merged);
          waitlists.set(channelId, []);

          await interaction.reply({
            content: "20모드로 전환했습니다. (시트 20명 명단에 참가자+대기자를 기록했습니다.)",
            ephemeral: true
          });

          await updateSignupMessage(channelId);
        } finally {
          releaseLock();
        }
      }

      else if (commandName === "re") {
        const channelId = interaction.channelId;
        await acquireLock();
        try {
          const mode = getMode(channelId);
          if (mode === "10") {
            await interaction.reply({
              content: "이미 10모드입니다.",
              ephemeral: true
            });
            return;
          }

          const list20 = await get20pList();
          const participants = list20.slice(0, 10);
          const wait = list20.slice(10);

          await set10pList(participants);
          await set20pList([]);

          modeMap.set(channelId, "10");
          signupCache.set(channelId, participants);
          waitlists.set(channelId, wait);

          await interaction.reply({
            content: "10모드로 되돌렸습니다. (참가자 10명 + 대기자로 분리)",
            ephemeral: true
          });

          await updateSignupMessage(channelId);
        } finally {
          releaseLock();
        }
      }
    }

    // 버튼 인터랙션
    else if (interaction.isButton()) {
      const channelId = interaction.channelId;
      const userName = interaction.member?.nickname || interaction.user.username;
      const mode = getMode(channelId);

      await acquireLock();
      try {
        await syncFromSheet(channelId);

        let participants = signupCache.get(channelId) || [];
        let wait = waitlists.get(channelId) || [];

        if (interaction.customId === "signup") {
          if (participants.includes(userName) || wait.includes(userName)) {
            await interaction.reply({
              content: "이미 신청하셨습니다.",
              ephemeral: true
            });
          } else {
            if (mode === "10") {
              if (participants.length < 10) {
                participants.push(userName);
                await set10pList(participants);
              } else {
                wait.push(userName);
              }
            } else {
              // 20모드: 참가자는 20명 명단에만 들어감
              participants.push(userName);
              await set20pList(participants);
            }

            signupCache.set(channelId, participants);
            waitlists.set(channelId, wait);

            await interaction.reply({
              content: "신청 완료!",
              ephemeral: true
            });

            await updateSignupMessage(channelId);
          }
        }

        else if (interaction.customId === "cancel") {
          const beforeP = participants.length;
          const beforeW = wait.length;

          participants = participants.filter(n => n !== userName);
          wait = wait.filter(n => n !== userName);

          if (beforeP === participants.length && beforeW === wait.length) {
            await interaction.reply({
              content: "신청 내역이 없습니다.",
              ephemeral: true
            });
          } else {
            if (mode === "10") {
              await set10pList(participants);
            } else {
              await set20pList(participants);
            }

            signupCache.set(channelId, participants);
            waitlists.set(channelId, wait);

            await interaction.reply({
              content: "취소 완료!",
              ephemeral: true
            });

            await updateSignupMessage(channelId);
          }
        }
      } finally {
        releaseLock();
      }
    }
  } catch (err) {
    console.error("interaction 처리 중 오류:", err);
    if (interaction.isRepliable()) {
      try {
        await interaction.reply({
          content: "오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
          ephemeral: true
        });
      } catch (_) {}
    }
  }
});

// ===============================
// 참가/대기자 메시지 업데이트
// ===============================
async function updateSignupMessage(channelId) {
  const channel = await client.channels.fetch(channelId);
  if (!channel) return;

  const msgId = signupMessages.get(channelId);
  if (!msgId) return;

  try {
    const msg = await channel.messages.fetch(msgId);
    if (!msg) return;

    const mode = getMode(channelId);
    const participants = signupCache.get(channelId) || [];
    const wait = waitlists.get(channelId) || [];

    let text;
    if (mode === "10") {
      text = "📢 오늘 굴뚝 내전 참가하실 분은 아래 버튼을 눌러주세요!\n\n";
      text += `현재 참가자 (${participants.length}명):\n`;
      text += participants.length > 0 ? participants.join(" ") : "없음";
      if (wait.length > 0) {
        text += `\n\n대기자 (${wait.length}명):\n${wait.join(" ")}`;
      }
    } else {
      text = "📢 20명 내전 모집중! 아래 버튼을 눌러주세요!\n\n";
      text += `현재 참가자 (${participants.length}명):\n`;
      text += participants.length > 0 ? participants.join(" ") : "없음";
    }

    await msg.edit({ content: text });
  } catch (err) {
    console.log("메시지 업데이트 오류:", err.message);
  }
}

// ===============================
client.login(BOT_TOKEN);
// ===============================
