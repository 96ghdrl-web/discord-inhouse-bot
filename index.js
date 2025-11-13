// ===============================
// 굴뚝 내전 봇 index.js
// - 10모드: 참가자 10명(시트 L5:L14) + 대기자(메모리)
// - 20모드: 참가자 20명(시트 L18:L37), 10명 명단 사용 X
// - /20 : 10모드 상태에서 참가+대기자를 20명 명단으로 옮기고 20모드 진입
// - /re : 20명 명단을 다시 참가자10 + 대기자로 되돌리고 10모드 복귀
// ===============================

// --------- Render에서 credentials.json 생성 ---------
const fs = require("fs");
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
const { google } = require("googleapis");
const cron = require("node-cron");
const config = require("./config.json");

// 환경변수 우선, 없으면 config.json 값 사용
const BOT_TOKEN = process.env.TOKEN;
const SHEET_ID = process.env.SHEET_ID || config.SHEET_ID;
const CHANNEL_ID = process.env.CHANNEL_ID || config.CHANNEL_ID;
const GUILD_ID = process.env.GUILD_ID || config.GUILD_ID;

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
// Render(배포 환경)에서는 환경변수의 JSON을 그대로 사용
// 로컬에서는 credentials.json 파일을 사용
let googleAuthOptions;

if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  // Render 등 환경변수 기반
  googleAuthOptions = {
    credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  };
} else {
  // 로컬 개발용 (credentials.json 파일)
  googleAuthOptions = {
    keyFile: "./credentials.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  };
}

const auth = new google.auth.GoogleAuth(googleAuthOptions);
const sheets = google.sheets({ version: "v4", auth });

// 시트 정보
const SHEET_NAME = "대진표";
const RANGE_10P = `${SHEET_NAME}!L5:L14`;   // 10명 명단
const RANGE_20P = `${SHEET_NAME}!L18:L37`;  // 20명 명단

// 참가 메시지 ID (채널별)
const signupMessages = new Map(); // channelId -> messageId

// 채널별 참가자 목록 (10 or 20명)
const participantsMap = new Map(); // channelId -> [이름, 이름, ...]

// 채널별 대기자 목록 (10모드에서만 사용)
const waitlists = new Map(); // channelId -> [이름, 이름, ...]

// 채널별 모드 ("10" or "20")
const modeMap = new Map(); // channelId -> "10" | "20"

// ===== 간단한 Lock (동시 처리 방지) =====
let sheetLock = false;

async function acquireLock() {
  while (sheetLock) {
    await new Promise((res) => setTimeout(res, 50));
  }
  sheetLock = true;
}
function releaseLock() {
  sheetLock = false;
}

// ===============================
// 유틸: 시트 읽기/쓰기
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
    requestBody: {
      values
    }
  });
}

async function get10pList() {
  const values = await readRange(RANGE_10P);
  return values.map((row) => (row[0] || "").trim()).filter(Boolean);
}

async function set10pList(names) {
  const rows = [];
  for (let i = 0; i < 10; i++) {
    rows.push([names[i] || ""]);
  }
  await writeRange(RANGE_10P, rows);
}

async function get20pList() {
  const values = await readRange(RANGE_20P);
  return values.map((row) => (row[0] || "").trim()).filter(Boolean);
}

async function set20pList(names) {
  const rows = [];
  for (let i = 0; i < 20; i++) {
    rows.push([names[i] || ""]);
  }
  await writeRange(RANGE_20P, rows);
}

// ===============================
// 모드/캐시 관련
// ===============================
function getMode(channelId) {
  return modeMap.get(channelId) || "10";
}

async function syncFromSheet(channelId) {
  const mode = getMode(channelId);

  if (mode === "10") {
    const list10 = await get10pList();
    participantsMap.set(channelId, list10);
    if (!waitlists.has(channelId)) waitlists.set(channelId, []);
  } else {
    const list20 = await get20pList();
    participantsMap.set(channelId, list20);
    waitlists.set(channelId, []); // 20모드에서는 대기자 사용 안 함
  }
}

function buildSignupText(channelId) {
  const mode = getMode(channelId);
  const participants = participantsMap.get(channelId) || [];
  const waits = waitlists.get(channelId) || [];

  if (mode === "10") {
    let text = "📢 오늘 굴뚝 내전 참가하실 분은 아래 버튼을 눌러주세요!\n\n";
    text += `현재 참가자 (${participants.length}명):\n`;
    text += participants.length > 0 ? participants.join(" ") : "없음";

    if (waits.length > 0) {
      text += `\n\n대기자 (${waits.length}명):\n`;
      text += waits.join(" ");
    }

    return text;
  } else {
    let text = "📢 20명 내전 모집중! 아래 버튼을 눌러주세요!\n\n";
    text += `현재 참가자 (${participants.length}명):\n`;
    text += participants.length > 0 ? participants.join(" ") : "없음";
    return text;
  }
}

async function updateSignupMessage(channelId) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  const msgId = signupMessages.get(channelId);
  if (!msgId) return;

  const msg = await channel.messages.fetch(msgId).catch(() => null);
  if (!msg) return;

  const text = buildSignupText(channelId);
  await msg.edit({ content: text }).catch((e) => {
    console.log("메시지 업데이트 오류:", e.message);
  });
}

// ===============================
// 봇 준비 완료
// ===============================
client.once("ready", async () => {
  console.log(`로그인 성공: ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName("내전모집")
      .setDescription("내전 참가/취소 버튼 메시지를 전송합니다.")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("내전멤버")
      .setDescription("현재 내전 참가자 및 대기자를 확인합니다.")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("20")
      .setDescription("참가자 + 대기자를 20명 명단에 넣고 20모드로 전환합니다.")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("re")
      .setDescription("20명 명단을 다시 참가자10 + 대기자로 되돌립니다.")
      .toJSON()
  ];

  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);

  try {
    if (GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, GUILD_ID),
        { body: commands }
      );
      console.log("[길드] 슬래시 명령어 등록 완료!");
    } else {
      await rest.put(Routes.applicationCommands(client.user.id), {
        body: commands
      });
      console.log("[글로벌] 슬래시 명령어 등록 완료!");
    }
  } catch (e) {
    console.error("슬래시 명령어 등록 중 오류:", e);
  }
});

// ===============================
// 인터랙션 처리
// ===============================
client.on("interactionCreate", async (interaction) => {
  try {
    // -----------------------
    // 슬래시 명령어
    // -----------------------
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;
      const channelId = interaction.channelId;

      // 기본 모드 설정
      if (!modeMap.has(channelId)) modeMap.set(channelId, "10");
      if (!waitlists.has(channelId)) waitlists.set(channelId, []);

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

        const text = buildSignupText(channelId);

        const msg = await interaction.reply({
          content: text,
          components: [row],
          fetchReply: true
        });

        signupMessages.set(channelId, msg.id);
      }

      else if (commandName === "내전멤버") {
        await syncFromSheet(channelId);

        const mode = getMode(channelId);
        const participants = participantsMap.get(channelId) || [];
        const waits = waitlists.get(channelId) || [];

        let text = `현재 모드: ${mode === "10" ? "10인 내전" : "20인 내전"}\n\n`;
        text += `참가자 (${participants.length}명):\n`;
        text += participants.length > 0 ? participants.join(" ") : "없음";

        if (mode === "10" && waits.length > 0) {
          text += `\n\n대기자 (${waits.length}명):\n${waits.join(" ")}`;
        }

        await interaction.reply({ content: text, ephemeral: true });
      }

      else if (commandName === "20") {
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

          await syncFromSheet(channelId);

          const participants = participantsMap.get(channelId) || [];
          const waits = waitlists.get(channelId) || [];

          const merged = [...participants, ...waits].slice(0, 20);

          await set20pList(merged);
          await set10pList([]); // 10명 명단은 비움

          modeMap.set(channelId, "20");
          participantsMap.set(channelId, merged);
          waitlists.set(channelId, []);

          await interaction.reply({
            content:
              "20모드로 전환했습니다. (참가자 + 대기자를 20명 명단에 기록했습니다.)",
            ephemeral: true
          });

          await updateSignupMessage(channelId);
        } finally {
          releaseLock();
        }
      }

      else if (commandName === "re") {
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
          const participants10 = list20.slice(0, 10);
          const waits = list20.slice(10);

          await set10pList(participants10);
          await set20pList([]);

          modeMap.set(channelId, "10");
          participantsMap.set(channelId, participants10);
          waitlists.set(channelId, waits);

          await interaction.reply({
            content:
              "10모드로 되돌렸습니다. (참가자 10명 + 대기자로 분리했습니다.)",
            ephemeral: true
          });

          await updateSignupMessage(channelId);
        } finally {
          releaseLock();
        }
      }
    }

    // -----------------------
    // 버튼 (참가 / 취소)
    // -----------------------
    else if (interaction.isButton()) {
      const channelId = interaction.channelId;
      const mode = getMode(channelId);

      // 디스코드 닉네임 우선, 없으면 username
      const userName =
        interaction.member?.nickname || interaction.user.username;

      await acquireLock();
      try {
        await syncFromSheet(channelId);

        let participants = participantsMap.get(channelId) || [];
        let waits = waitlists.get(channelId) || [];

        if (interaction.customId === "signup") {
          if (participants.includes(userName) || waits.includes(userName)) {
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
                waits.push(userName);
              }
            } else {
              // 20모드: 20명 명단에만 기록
              if (participants.length >= 20) {
                await interaction.reply({
                  content: "이미 20명이 모두 채워졌습니다.",
                  ephemeral: true
                });
                return;
              }
              participants.push(userName);
              await set20pList(participants);
            }

            participantsMap.set(channelId, participants);
            waitlists.set(channelId, waits);

            await interaction.reply({
              content: "신청 완료!",
              ephemeral: true
            });

            await updateSignupMessage(channelId);
          }
        } else if (interaction.customId === "cancel") {
          const beforeP = participants.length;
          const beforeW = waits.length;

          participants = participants.filter((n) => n !== userName);
          waits = waits.filter((n) => n !== userName);

          if (beforeP === participants.length && beforeW === waits.length) {
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

            participantsMap.set(channelId, participants);
            waitlists.set(channelId, waits);

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
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({
            content: "오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
            ephemeral: true
          });
        } else {
          await interaction.reply({
            content: "오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
            ephemeral: true
          });
        }
      } catch (_) {}
    }
  }
});

// ===============================
// Render 무료 Web Service용 더미 HTTP 서버
// ===============================
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is running\n");
}).listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});

// 디스코드 봇 로그인
client.login(BOT_TOKEN);
// ===============================


