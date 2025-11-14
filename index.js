// ===============================
// 굴뚝 내전 봇 index.js
// - 10모드: 참가자 10명(시트 L5:L14) + 대기자(메모리)
// - 20모드: 참가자 20명(시트 L18:L37), 10명 명단 사용 X
// - /20 : 10모드 상태에서 참가+대기자를 20명 명단으로 옮기고 20모드 진입
// - /re : 20명 명단을 다시 참가자10 + 대기자로 되돌리고 10모드 복귀
// - /굴뚝딱가리 : 윤섭 멘션
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
const sheets = google.sheets({ version: "v4", auth });

// 시트 정보
const SHEET_NAME = "대진표";
const RANGE_10P = `${SHEET_NAME}!L5:L14`;
const RANGE_20P = `${SHEET_NAME}!L18:L37`;

// 참가 메시지 ID
const signupMessages = new Map();
const participantsMap = new Map();
const waitlists = new Map();
const modeMap = new Map();

// ===== Lock =====
let sheetLock = false;

async function acquireLock() {
  while (sheetLock) await new Promise((res) => setTimeout(res, 50));
  sheetLock = true;
}
function releaseLock() {
  sheetLock = false;
}

// ===============================
// 공통 유틸: 표시 이름 우선순위
// 서버 닉네임 > Display Name(globalName) > username
// ===============================
function getMemberDisplayName(member) {
  if (!member) return null;
  return member.nickname || member.user.globalName || member.user.username;
}

// ===============================
// 시트 유틸
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
    .map((row) => (row[0] || "").trim())
    .filter(Boolean);
}
async function set10pList(list) {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push([list[i] || ""]);
  await writeRange(RANGE_10P, rows);
}

async function get20pList() {
  return (await readRange(RANGE_20P))
    .map((row) => (row[0] || "").trim())
    .filter(Boolean);
}
async function set20pList(list) {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push([list[i] || ""]);
  await writeRange(RANGE_20P, rows);
}

// ===============================
// 모드 유틸
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
    waitlists.set(channelId, []);
  }
}

// ===============================
// 닉네임/표시 이름 유틸
// (저장된 문자열을 서버 닉/DisplayName/username 중 현재 값으로 치환)
// ===============================
async function buildDisplayNames(guild, names) {
  if (!guild || !names || names.length === 0) return names || [];

  const members = await guild.members.fetch().catch(() => null);
  if (!members) return names;

  return names.map((name) => {
    const m = members.find(
      (x) =>
        x.nickname === name ||
        x.user.globalName === name ||
        x.user.username === name
    );
    if (!m) return name;
    return getMemberDisplayName(m);
  });
}

// 참가/대기자 텍스트 생성 (일반 텍스트 + 닉네임 치환)
async function buildSignupText(channelId, guild) {
  const mode = getMode(channelId);
  const participants = participantsMap.get(channelId) || [];
  const waits = waitlists.get(channelId) || [];

  const displayParticipants = await buildDisplayNames(guild, participants);
  const displayWaits = await buildDisplayNames(guild, waits);

  if (mode === "10") {
    let text = "📢 오늘 굴뚝 내전 참가하실 분은 아래 버튼을 눌러주세요!\n\n";
    text += `현재 참가자 (${participants.length}명):\n`;
    text += participants.length ? displayParticipants.join(" ") : "없음";

    if (waits.length > 0) {
      text += `\n\n대기자 (${waits.length}명):\n`;
      text += displayWaits.join(" ");
    }
    return text;
  } else {
    let text = "📢 20명 내전 모집중! 아래 버튼을 눌러주세요!\n\n";
    text += `현재 참가자 (${participants.length}명):\n`;
    text += participants.length ? displayParticipants.join(" ") : "없음";
    return text;
  }
}

// 모집 메시지 내용을 실제 디스코드 메시지에 반영하는 함수
async function updateSignupMessage(channelId) {
  const messageId = signupMessages.get(channelId);
  if (!messageId) return;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (!message) return;

  const newContent = await buildSignupText(channelId, channel.guild);

  await message.edit({
    content: newContent,
    components: message.components || []
  });
}

// 멘션 변환 (/시작 명령어에서만 사용 – 진짜 알림용)
async function buildMentionsForNames(guild, names) {
  if (!guild || !names || names.length === 0) return names || [];

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
// 봇 준비
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
      .setDescription("현재 내전 참가자/대기자를 확인합니다.")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("20")
      .setDescription("현재 참가자/대기자를 20명 모드로 전환합니다.")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("re")
      .setDescription("20명 모드에서 다시 10명+대기자 모드로 되돌립니다.")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("시작")
      .setDescription("현재 참가자들에게 내전 시작 멘션을 보냅니다.")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("굴뚝딱가리")
      .setDescription("윤섭아 너 부른다.")
      .toJSON()
  ];

  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);

  try {
    if (GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, GUILD_ID),
        { body: commands }
      );
      console.log("[길드] 명령어 등록 완료");
    } else {
      await rest.put(Routes.applicationCommands(client.user.id), {
        body: commands
      });
      console.log("[글로벌] 명령어 등록 완료");
    }
  } catch (err) {
    console.error(err);
  }

  // ===============================
  // 매일 17시(KST) 자동 모집 메시지
  // ===============================
  if (CHANNEL_ID) {
    cron.schedule(
      "0 17 * * *",
      async () => {
        try {
          const channelId = CHANNEL_ID;

          if (!modeMap.has(channelId)) modeMap.set(channelId, "10");
          if (!waitlists.has(channelId)) waitlists.set(channelId, []);

          await syncFromSheet(channelId);

          const channel = await client.channels
            .fetch(channelId)
            .catch(() => null);
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

          const text = await buildSignupText(channelId, channel.guild);

          const prevId = signupMessages.get(channelId);
          if (prevId) {
            const prev = await channel.messages.fetch(prevId).catch(() => null);
            if (prev) prev.delete().catch(() => {});
          }

          const msg = await channel.send({
            content: text,
            components: [row]
          });

          signupMessages.set(channelId, msg.id);
          console.log("자동 내전모집 메시지 전송 완료");
        } catch (e) {
          console.error("자동 내전모집 실패:", e);
        }
      },
      {
        timezone: "Asia/Seoul"
      }
    );
  } else {
    console.log("CHANNEL_ID 미설정 - 자동 내전모집 비활성화");
  }
});

// ===============================
// 인터랙션 처리
// ===============================
client.on("interactionCreate", async (interaction) => {
  try {
    const channelId = interaction.channelId;

    // ===========================
    // 슬래시 명령어
    // ===========================
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      if (!modeMap.has(channelId)) modeMap.set(channelId, "10");
      if (!waitlists.has(channelId)) waitlists.set(channelId, []);

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

        const text = await buildSignupText(channelId, interaction.guild);

        const prevId = signupMessages.get(channelId);
        if (prevId) {
          const prev = await interaction.channel.messages
            .fetch(prevId)
            .catch(() => null);
          if (prev) prev.delete().catch(() => {});
        }

        const msg = await interaction.reply({
          content: text,
          components: [row],
          fetchReply: true
        });

        signupMessages.set(channelId, msg.id);
      }

      // /내전멤버
      else if (commandName === "내전멤버") {
        await syncFromSheet(channelId);

        const mode = getMode(channelId);
        const p = participantsMap.get(channelId) || [];
        const w = waitlists.get(channelId) || [];

        const displayP = await buildDisplayNames(interaction.guild, p);
        const displayW = await buildDisplayNames(interaction.guild, w);

        let text = `현재 모드: ${mode}\n\n`;
        text += `참가자 (${p.length}명):\n${
          p.length ? displayP.join(" ") : "없음"
        }`;

        if (mode === "10" && w.length)
          text += `\n\n대기자 (${w.length}명):\n${displayW.join(" ")}`;

        await interaction.reply({ content: text, ephemeral: true });
      }

      // /20
      else if (commandName === "20") {
        await acquireLock();
        try {
          const mode = getMode(channelId);
          if (mode === "20")
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
            content: "20모드로 전환했습니다!",
            ephemeral: true
          });

          await updateSignupMessage(channelId);
        } finally {
          releaseLock();
        }
      }

      // /re
      else if (commandName === "re") {
        await acquireLock();
        try {
          const mode = getMode(channelId);
          if (mode === "10")
            return interaction.reply({
              content: "이미 10모드입니다.",
              ephemeral: true
            });

          const list20 = await get20pList();
          const p10 = list20.slice(0, 10);
          const waits = list20.slice(10);

          await set10pList(p10);
          await set20pList([]);

          modeMap.set(channelId, "10");
          participantsMap.set(channelId, p10);
          waitlists.set(channelId, waits);

          await interaction.reply({
            content: "10모드로 되돌렸습니다.",
            ephemeral: true
          });

          await updateSignupMessage(channelId);
        } finally {
          releaseLock();
        }
      }

      // /시작
      else if (commandName === "시작") {
        await syncFromSheet(channelId);

        const p = participantsMap.get(channelId) || [];
        if (!p.length)
          return interaction.reply({
            content: "현재 참가자가 없습니다.",
            ephemeral: true
          });

        const mentions = await buildMentionsForNames(interaction.guild, p);

        await interaction.reply({
          content: `${mentions.join(" ")}\n내전 시작합니다! 모두 모여주세요~`
        });
      }

      // /굴뚝딱가리
      else if (commandName === "굴뚝딱가리") {
        const members = await interaction.guild.members.fetch().catch(() => null);
        if (!members) {
          return interaction.reply({
            content: "길드 멤버 정보를 가져올 수 없습니다.",
            ephemeral: true
          });
        }

        const targetName = "윤섭";
        const target = members.find(
          (m) =>
            m.nickname === targetName ||
            m.user.globalName === targetName ||
            m.user.username === targetName
        );

        if (!target) {
          return interaction.reply({
            content: "윤섭을 찾지 못했습니다.",
            ephemeral: true
          });
        }

        return interaction.reply({
          content: `<@${target.id}> 윤섭아 너 부른다`,
          ephemeral: false
        });
      }
    }

    // ===========================
    // 버튼 클릭 처리
    // ===========================
    else if (interaction.isButton()) {
      // 3초 제한 회피용 빠른 ACK
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "처리 중입니다...",
          ephemeral: true
        });
      }

      await acquireLock();
      try {
        await syncFromSheet(channelId);
        const mode = getMode(channelId);

        const member = await interaction.guild.members
          .fetch(interaction.user.id)
          .catch(() => null);

        const userName = getMemberDisplayName(member);
        if (!userName) {
          await interaction.editReply({
            content: "사용자 정보를 가져올 수 없습니다."
          });
          return;
        }

        let p = participantsMap.get(channelId) || [];
        let w = waitlists.get(channelId) || [];
        let replyText = "";
        let needUpdateMessage = false;

        if (interaction.customId === "signup") {
          if (p.includes(userName) || w.includes(userName)) {
            replyText = "이미 신청하셨습니다.";
          } else {
            if (mode === "10") {
              if (p.length < 10) {
                p.push(userName);
                await set10pList(p);
                replyText = "신청 완료!";
              } else {
                w.push(userName);
                replyText = "정원이 꽉 차서 대기자로 등록되었습니다.";
              }
            } else {
              if (p.length >= 20) {
                replyText = "20명이 모두 찼습니다.";
              } else {
                p.push(userName);
                await set20pList(p);
                replyText = "신청 완료!";
              }
            }

            participantsMap.set(channelId, p);
            waitlists.set(channelId, w);
            needUpdateMessage = true;
          }
        } else if (interaction.customId === "cancel") {
          const beforeP = p.length;
          const beforeW = w.length;

          p = p.filter((n) => n !== userName);
          w = w.filter((n) => n !== userName);

          if (beforeP === p.length && beforeW === w.length) {
            replyText = "신청 기록이 없습니다.";
          } else {
            if (mode === "10") {
              if (p.length < 10 && w.length > 0) {
                const promoted = w.shift();
                if (promoted) p.push(promoted);
              }
              await set10pList(p);
            } else {
              await set20pList(p);
            }

            participantsMap.set(channelId, p);
            waitlists.set(channelId, w);
            replyText = "취소 완료!";
            needUpdateMessage = true;
          }
        }

        if (replyText) {
          await interaction.editReply({ content: replyText });
        }

        if (needUpdateMessage) {
          await interaction.message.edit({
            content: await buildSignupText(channelId, interaction.guild),
            components: interaction.message.components
          });
        }
      } finally {
        releaseLock();
      }
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.editReply({
            content: "오류가 발생했습니다. 다시 시도해주세요."
          });
        } else {
          await interaction.reply({
            content: "오류가 발생했습니다. 다시 시도해주세요.",
            ephemeral: true
          });
        }
      } catch (_) {}
    }
  }
});

// 로그인
client.login(BOT_TOKEN);

// ===============================
// UptimeRobot용 HTTP 서버
// ===============================
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Bot is running\n");
  })
  .listen(PORT, () => console.log(`HTTP server on ${PORT}`));
