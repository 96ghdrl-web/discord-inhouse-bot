// ===============================
// 굴뚝 내전 봇 index.js — 최종 안정화 + 즉시 갱신 + 멘션 + 데일리 초기화
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

// ===============================
// 환경 변수 / 기본 설정
// ===============================
const BOT_TOKEN = process.env.TOKEN;
const SHEET_ID = process.env.SHEET_ID || config.SHEET_ID;
const CHANNEL_ID = process.env.CHANNEL_ID || config.CHANNEL_ID;
const GUILD_ID = process.env.GUILD_ID || config.GUILD_ID;

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
const sheets = google.sheets({ version: "v4", auth });

const SHEET_NAME = "대진표";
const RANGE_10P = `${SHEET_NAME}!L5:L14`;
const RANGE_20P = `${SHEET_NAME}!L18:L37`;

// ===============================
// 데이터 저장소
// ===============================
const signupMessages = new Map();   // 채널별 모집 메시지 ID
const participantsMap = new Map();  // 채널별 참가자 목록(문자열)
const waitlists = new Map();        // 채널별 대기자 목록(문자열)
const modeMap = new Map();          // 채널별 모드("10" | "20")

// 메시지 업데이트 충돌 방지용 Lock
const messageUpdateLock = new Map();

// Sheet Lock
let sheetLock = false;

// ===============================
// Lock 유틸
// ===============================
async function acquireLock() {
  while (sheetLock) await new Promise(res => setTimeout(res, 20));
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
    .map(r => (r[0] || "").trim())
    .filter(Boolean);
}

async function set10pList(list) {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push([list[i] || ""]);
  await writeRange(RANGE_10P, rows);
}

async function get20pList() {
  return (await readRange(RANGE_20P))
    .map(r => (r[0] || "").trim())
    .filter(Boolean);
}

async function set20pList(list) {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push([list[i] || ""]);
  await writeRange(RANGE_20P, rows);
}

// ===============================
// 모드 & 참가 정보 동기화
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

  return names.map(name => {
    const m = members.find(
      x =>
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

  return names.map(name => {
    const m = members.find(
      x =>
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
    let text = "📢 오늘 굴뚝 내전 참가자 모집!\n\n";
    text += `참가자 (${p.length}명):\n${p.length ? dp.join(" ") : "없음"}`;
    if (w.length)
      text += `\n\n대기자 (${w.length}명):\n${dw.join(" ")}`;
    return text;
  }

  let text = "📢 20명 내전 모집!\n\n";
  text += `참가자 (${p.length}명):\n${p.length ? dp.join(" ") : "없음"}`;
  return text;
}

// ===============================
// 메시지 업데이트 (충돌 방지 버전)
//   - /20, /re, cron에서 사용
//   - 버튼 클릭은 interaction.message.edit()으로 즉시 갱신
// ===============================
function safeUpdateSignupMessage(channelId) {
  if (!signupMessages.get(channelId)) return;

  // 이미 업데이트 중 → queued 처리
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

      const newText = await buildSignupText(channelId, channel.guild);

      await msg.edit({
        content: newText,
        components: msg.components
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
    new SlashCommandBuilder().setName("내전모집").setDescription("내전 참가 버튼 메시지 생성"),
    new SlashCommandBuilder().setName("내전멤버").setDescription("현재 참가자 확인"),
    new SlashCommandBuilder().setName("20").setDescription("20인 모드로 전환"),
    new SlashCommandBuilder().setName("re").setDescription("10인 모드로 전환"),
    new SlashCommandBuilder().setName("시작").setDescription("참가자 소집"),
    new SlashCommandBuilder().setName("굴뚝딱가리").setDescription("윤섭 호출")
  ].map(c => c.toJSON());

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

      if (!modeMap.has(channelId)) modeMap.set(channelId, "10");
      if (!waitlists.has(channelId)) waitlists.set(channelId, []);

      // /내전모집
      if (commandName === "내전모집") {
        await syncFromSheet(channelId);

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("signup").setLabel("참가").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("cancel").setLabel("취소").setStyle(ButtonStyle.Danger)
        );

        const text = await buildSignupText(channelId, interaction.guild);

        const prevId = signupMessages.get(channelId);
        if (prevId) {
          const prev = await interaction.channel.messages.fetch(prevId).catch(() => null);
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
            return interaction.reply({ content: "이미 20모드입니다.", ephemeral: true });

          await syncFromSheet(channelId);
          const p = participantsMap.get(channelId) || [];
          const w = waitlists.get(channelId) || [];

          const merged = [...p, ...w].slice(0, 20);

          await set20pList(merged);
          await set10pList([]);

          modeMap.set(channelId, "20");
          participantsMap.set(channelId, merged);
          waitlists.set(channelId, []);

          await interaction.reply({ content: "20모드로 전환되었습니다!", ephemeral: true });
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
            return interaction.reply({ content: "이미 10모드입니다.", ephemeral: true });

          const list20 = await get20pList();
          const p10 = list20.slice(0, 10);
          const w = list20.slice(10);

          await set10pList(p10);
          await set20pList([]);

          modeMap.set(channelId, "10");
          participantsMap.set(channelId, p10);
          waitlists.set(channelId, w);

          await interaction.reply({ content: "10모드로 전환되었습니다!", ephemeral: true });
          setTimeout(() => safeUpdateSignupMessage(channelId), 200);
        } finally {
          releaseLock();
        }
      }

      // /시작 (참가자 멘션 + 안내 문구)
      else if (commandName === "시작") {
        await syncFromSheet(channelId);

        const p = participantsMap.get(channelId) || [];
        if (!p.length) {
          return interaction.reply({ content: "현재 참가자가 없습니다.", ephemeral: true });
        }

        const mentions = await buildMentionsForNames(interaction.guild, p);
        await interaction.reply({
          content: `${mentions.join(" ")}\n내전 시작합니다! 모두 모여주세요~`
        });
      }

      // /굴뚝딱가리
      else if (commandName === "굴뚝딱가리") {
        const members = await interaction.guild.members.fetch().catch(() => null);
        if (!members) {
          return interaction.reply({ content: "멤버 정보를 불러올 수 없습니다.", ephemeral: true });
        }

        const target = members.find(
          m =>
            m.nickname === "윤섭" ||
            m.user.globalName === "윤섭" ||
            m.user.username === "윤섭"
        );

        if (!target) {
          return interaction.reply({ content: "윤섭을 찾을 수 없습니다.", ephemeral: true });
        }

        return interaction.reply({
          content: `<@${target.id}> 윤섭아 너 부른다.`,
          ephemeral: false
        });
      }
    }

    // ------------------------------
    // Button (참가/취소) — 메시지 즉시 갱신
    // ------------------------------
    else if (interaction.isButton()) {
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.deferReply({ ephemeral: true });
        }
      } catch {
        return;
      }

      await acquireLock();
      let replyText = "";
      let needUpdate = false;

      try {
        await syncFromSheet(channelId);

        const mode = getMode(channelId);
        const member = await interaction.guild.members
          .fetch(interaction.user.id)
          .catch(() => null);
        const userName = getMemberDisplayName(member);

        if (!userName) {
          replyText = "사용자 정보를 불러올 수 없습니다.";
        } else {
          let p = participantsMap.get(channelId) || [];
          let w = waitlists.get(channelId) || [];

          // 참가
          if (interaction.customId === "signup") {
            if (p.includes(userName) || w.includes(userName)) {
              replyText = "이미 신청한 상태입니다.";
            } else {
              if (mode === "10") {
                if (p.length < 10) {
                  p.push(userName);
                  await set10pList(p);
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
                  await set20pList(p);
                  replyText = "참가 완료!";
                }
              }
              participantsMap.set(channelId, p);
              waitlists.set(channelId, w);
              needUpdate = true;
            }
          }

          // 취소
          else if (interaction.customId === "cancel") {
            const oldP = p.length;
            const oldW = w.length;

            p = p.filter(n => n !== userName);
            w = w.filter(n => n !== userName);

            if (p.length === oldP && w.length === oldW) {
              replyText = "신청 기록이 없습니다.";
            } else {
              if (mode === "10") {
                if (p.length < 10 && w.length > 0) {
                  const moved = w.shift();
                  if (moved) p.push(moved);
                }
                await set10pList(p);
              } else {
                await set20pList(p);
              }

              participantsMap.set(channelId, p);
              waitlists.set(channelId, w);
              replyText = "신청이 취소되었습니다!";
              needUpdate = true;
            }
          }
        }
      } finally {
        releaseLock();
      }

      // 눌렀던 모집 메시지 바로 갱신
      if (needUpdate) {
        try {
          const newText = await buildSignupText(channelId, interaction.guild);
          await interaction.message.edit({
            content: newText,
            components: interaction.message.components
          });
        } catch (e) {
          console.error("button message.edit error:", e);
        }
      }

      // 에페메랄 응답
      try {
        await interaction.editReply({
          content: replyText || "처리 중 오류가 발생했습니다."
        });
      } catch {}
    }

  } catch (e) {
    console.error("interactionCreate error:", e);
  }
});

// ===============================
// 자동 모집 (매일 17시, 명단 초기화 후 모집)
// ===============================
cron.schedule(
  "0 17 * * *",
  async () => {
    try {
      const channelId = CHANNEL_ID;
      if (!channelId) return;

      await acquireLock();
      try {
        // 항상 10인 모드로 초기화
        modeMap.set(channelId, "10");

        // 시트 내전 명단 초기화
        await set10pList([]);
        await set20pList([]);

        // 메모리 참가/대기자 초기화
        participantsMap.set(channelId, []);
        waitlists.set(channelId, []);
      } finally {
        releaseLock();
      }

      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) return;

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("signup").setLabel("참가").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("cancel").setLabel("취소").setStyle(ButtonStyle.Danger)
      );

      const text = await buildSignupText(channelId, channel.guild); // 참가자 0명 기준

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
