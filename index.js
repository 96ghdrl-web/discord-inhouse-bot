// ===============================
// 굴뚝 내전 봇 index.js
// - 10모드: 참가자 10명(시트 L5:L14) + 대기자(메모리)
// - 20모드: 참가자 전원 20명 명단(시트 L18:L37), 10명 명단 사용 X
// - /20 : 10모드 상태에서 참가+대기자를 20명 명단으로 옮기고 20모드 진입
// - /re : 20명 명단을 다시 참가10 + 대기자로 되돌리고 10모드 복귀
// ===============================

require("dotenv").config(); // 👉 .env / Railway 환경변수에서 TOKEN 읽을 준비

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

// --------- 디스코드 클라이언트 ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// ✅ 토큰은 무조건 환경변수에서만 읽는다.
//   (로컬에서는 .env, Railway에서는 Variables)
const BOT_TOKEN = process.env.TOKEN;

// --------- 구글 시트 인증 ----------
const auth = new google.auth.GoogleAuth({
  keyFile: "credentials.json",
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
const waitlists = new Map(); // key: channelId, value: string[]

// 채널별 모드: "10" | "20"
const modes = new Map(); // key: channelId, value: string

function getMode(channelId) {
  return modes.get(channelId) || "10";
}
function setMode(channelId, mode) {
  modes.set(channelId, mode);
}

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

  // ✅ 여기서도 환경변수 토큰 사용
  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);

  if (config.GUILD_ID) {
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, config.GUILD_ID),
      { body: commands }
    );
    console.log(`/내전모집 /내전멤버 /20 /re 길드 명령어 등록 완료! (GUILD_ID=${config.GUILD_ID})`);
  }

  // 옛날 전역(Global) 명령어 전체 삭제
  await rest.put(
    Routes.applicationCommands(client.user.id),
    { body: [] }
  );
  console.log("전역(Global) 슬래시 명령어 전체 삭제 완료!");
});

// ===============================
// 매일 18시에 자동 모집 메시지
// ===============================
cron.schedule("0 18 * * *", async () => {
  const channel = client.channels.cache.get(config.CHANNEL_ID);
  if (!channel) return;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("join").setLabel("참가").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("leave").setLabel("취소").setStyle(ButtonStyle.Danger)
  );

  const msg = await channel.send({
    content: baseText10(),
    components: [row]
  });

  signupMessages.set(channel.id, msg.id);
  setMode(channel.id, "10");
  await updateSignupMessage(channel.id);
});

// ===============================
// interaction 처리 (슬래시 + 버튼)
// ===============================
client.on("interactionCreate", async interaction => {
  try {
    // ---- 슬래시 명령어 ----
    if (interaction.isChatInputCommand()) {
      const command = interaction.commandName;
      const channelId = interaction.channelId;

      // /내전모집
      if (command === "내전모집") {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("join").setLabel("참가").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("leave").setLabel("취소").setStyle(ButtonStyle.Danger)
        );

        const mode = getMode(channelId);

        // 현재 모드가 20모드라면 그대로 유지
        if (mode === "20") {
          const msg = await interaction.channel.send({
            content: baseText20(),   // 📢 20명 내전 모집중! ...
            components: [row]
          });

          signupMessages.set(channelId, msg.id);
          await interaction.reply({
            content: "현재 20모드 유지 상태에서 모집 메시지를 새로 생성했습니다.",
            ephemeral: true
          });
          await updateSignupMessage(channelId); // 20명 명단 기준으로 메시지 내용 채워짐
          return;
        }

        // 그 외에는 10모드용 모집 메시지
        const msg = await interaction.channel.send({
          content: baseText10(),     // 📢 오늘 굴뚝 내전 참가하실 분은 ...
          components: [row]
        });

        signupMessages.set(channelId, msg.id);
        setMode(channelId, "10");    // 10모드로 유지/전환
        await interaction.reply({
          content: "10모드에서 내전 모집 메시지를 생성했습니다.",
          ephemeral: true
        });
        await updateSignupMessage(channelId);   // 참가자+대기자 그대로 표시
        return;
      }

      // /내전멤버
      if (command === "내전멤버") {
        await interaction.deferReply({ ephemeral: true });

        const mode = getMode(channelId);

        if (mode === "10") {
          const participantsRaw = await readParticipantsRaw();
          const participants = participantsRaw.filter(Boolean);
          const waiters = getWaitlist(channelId);

          if (participants.length === 0 && waiters.length === 0) {
            await interaction.editReply("현재 참가자/대기자가 없습니다.");
            return;
          }

          let text = "";
          if (participants.length > 0) {
            text += `현재 참가자 (${participants.length}명):\n${participants.join(" ")}\n`;
          }
          if (waiters.length > 0) {
            text += `\n대기자 (${waiters.length}명):\n${waiters.join(" ")}`;
          }
          await interaction.editReply(text);
        } else {
          const list20 = await read20Raw();
          const participants = list20.filter(Boolean);

          if (participants.length === 0) {
            await interaction.editReply("현재 20명 명단에 참가자가 없습니다.");
            return;
          }

          const text =
            `현재 (20모드) 참가자 (${participants.length}명):\n` +
            participants.join(" ");
          await interaction.editReply(text);
        }
        return;
      }

      // /20 : 10모드 -> 20모드 전환
      if (command === "20") {
        await interaction.deferReply({ ephemeral: true });
        const mode = getMode(channelId);

        await acquireLock();
        try {
          if (mode === "20") {
            await interaction.editReply("이미 20모드입니다.");
            return;
          }

          const participantsRaw = await readParticipantsRaw();
          const participants = participantsRaw.filter(Boolean);
          const waiters = getWaitlist(channelId);
          const all = participants.concat(waiters).slice(0, 20);

          if (all.length === 0) {
            await interaction.editReply("참가자/대기자가 없습니다. 먼저 모집부터 해주세요.");
            return;
          }

          // 20명 명단 채우기
          await fill20List(all);
          // 10명 명단 비우기
          await clear10List();
          // 대기자 초기화
          setWaitlist(channelId, []);
          // 모드 전환
          setMode(channelId, "20");

          // 메시지 갱신
          await updateSignupMessage(channelId);

          await interaction.editReply(
            `20모드로 전환했습니다. (현재 20명 명단에 ${all.length}명 기록)`
          );
        } finally {
          releaseLock();
        }
        return;
      }

      // /re : 20모드 -> 10모드 복귀
      if (command === "re") {
        await interaction.deferReply({ ephemeral: true });
        const mode = getMode(channelId);

        await acquireLock();
        try {
          if (mode === "10") {
            await interaction.editReply("현재는 이미 10모드입니다.");
            return;
          }

          const list20 = await read20Raw();
          const all = list20.filter(Boolean);

          if (all.length === 0) {
            await interaction.editReply("20명 명단이 비어 있습니다. /20 으로 먼저 채워주세요.");
            return;
          }

          const participants = all.slice(0, 10);
          const waiters = all.slice(10);

          await setParticipants(participants);
          setWaitlist(channelId, waiters);
          await clear20List();
          setMode(channelId, "10");

          await updateSignupMessage(channelId);

          await interaction.editReply(
            `10모드로 되돌렸습니다. (참가자 ${participants.length}명, 대기자 ${waiters.length}명)`
          );
        } finally {
          releaseLock();
        }
        return;
      }

      return;
    }

    // ---- 버튼 ----
    if (!interaction.isButton()) return;

    const userName = interaction.member?.displayName ?? interaction.user.username;
    const channelId = interaction.channelId;
    const mode = getMode(channelId);

    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true });
    }

    await acquireLock();
    try {
      // ===================
      // 10모드 버튼 처리
      // ===================
      if (mode === "10") {
        const participantsRaw = await readParticipantsRaw();
        const participants = participantsRaw.filter(Boolean);
        let waiters = getWaitlist(channelId).slice();

        const isParticipant = participants.includes(userName);
        const isWaiter = waiters.includes(userName);

        // 참가
        if (interaction.customId === "join") {
          if (isParticipant) {
            await interaction.editReply("이미 참가자 명단에 등록되어 있습니다.");
            return;
          }
          if (isWaiter) {
            await interaction.editReply("이미 대기자 명단에 등록되어 있습니다.");
            return;
          }

          if (participants.length < 10) {
            await addParticipant(userName);
            await interaction.editReply("참가자 명단에 등록되었습니다!");
          } else {
            if (waiters.length >= 10) {
              await interaction.editReply("참가자(10명)와 대기자(10명)가 모두 가득 찼습니다.");
              return;
            }
            waiters.push(userName);
            setWaitlist(channelId, waiters);
            await interaction.editReply(
              `대기자 명단에 등록되었습니다! (현재 대기자 ${waiters.length}명)`
            );

            // 참가 10 + 대기 10 = 20 → 자동으로 20명 명단 갱신 (모드는 그대로 10)
            if (participants.length === 10 && waiters.length === 10) {
              const all = participants.concat(waiters);
              await fill20List(all);
            }
          }

          await updateSignupMessage(channelId);
          return;
        }

        // 취소
        if (interaction.customId === "leave") {
          if (isWaiter) {
            waiters = waiters.filter(n => n !== userName);
            setWaitlist(channelId, waiters);
            await interaction.editReply("대기자 명단에서 취소되었습니다.");
            await updateSignupMessage(channelId);
            return;
          }

          if (isParticipant) {
            await removeParticipant(userName);
            if (waiters.length > 0) {
              const promoted = waiters.shift();
              setWaitlist(channelId, waiters);
              await addParticipant(promoted);
            }
            await interaction.editReply("참가자 명단에서 취소되었습니다.");
            await updateSignupMessage(channelId);
            return;
          }

          await interaction.editReply("현재 참가/대기 명단에 등록되어 있지 않습니다.");
          return;
        }
      }

      // ===================
      // 20모드 버튼 처리
      // ===================
      if (mode === "20") {
        const list20 = await read20Raw();
        const participants = list20.filter(Boolean);
        const isParticipant = participants.includes(userName);

        // 참가
        if (interaction.customId === "join") {
          if (isParticipant) {
            await interaction.editReply("이미 20명 명단에 등록되어 있습니다.");
            return;
          }

          if (participants.length >= 20) {
            await interaction.editReply("20명 정원이 가득 찼습니다.");
            return;
          }

          await addParticipant20(userName);
          await interaction.editReply("20명 명단에 등록되었습니다!");
          await updateSignupMessage(channelId);
          return;
        }

        // 취소
        if (interaction.customId === "leave") {
          if (!isParticipant) {
            await interaction.editReply("현재 20명 명단에 등록되어 있지 않습니다.");
            return;
          }

          await removeParticipant20(userName);
          await interaction.editReply("20명 명단에서 취소되었습니다.");
          await updateSignupMessage(channelId);
          return;
        }
      }
    } finally {
      releaseLock();
    }
  } catch (err) {
    console.error("interaction 처리 중 오류:", err);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
          ephemeral: true
        });
      } else if (interaction.deferred && !interaction.replied) {
        await interaction.editReply("오류가 발생했습니다. 잠시 후 다시 시도해 주세요.");
      }
    } catch (e) {
      console.error("오류 응답 실패:", e);
    }
  }
});

// ===============================
// 유틸 함수들
// ===============================

function baseText10() {
  return "📢 오늘 굴뚝 내전 참가하실 분은 아래 버튼을 눌러주세요!";
}
function baseText20() {
  return "📢 20명 내전 모집중! 아래 버튼을 눌러주세요!";
}

function getWaitlist(channelId) {
  return waitlists.get(channelId) || [];
}
function setWaitlist(channelId, arr) {
  waitlists.set(channelId, arr);
}

// 참가자 10명 raw (길이 10, 빈칸 null)
async function readParticipantsRaw() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.SHEET_ID,
    range: RANGE_10P
  });

  const values = res.data.values || [];
  const arr = new Array(10).fill(null);

  for (let i = 0; i < Math.min(values.length, 10); i++) {
    if (values[i] && values[i][0]) arr[i] = values[i][0];
  }
  return arr;
}

// 20명 명단 raw (길이 20, 빈칸 null)
async function read20Raw() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.SHEET_ID,
    range: RANGE_20P
  });

  const values = res.data.values || [];
  const arr = new Array(20).fill(null);

  for (let i = 0; i < Math.min(values.length, 20); i++) {
    if (values[i] && values[i][0]) arr[i] = values[i][0];
  }
  return arr;
}

// 참가자 전체를 주어진 리스트로 재설정 (10모드용)
async function setParticipants(list) {
  const values = list.map(n => [n]);

  await sheets.spreadsheets.values.clear({
    spreadsheetId: config.SHEET_ID,
    range: RANGE_10P
  });

  if (values.length === 0) return;

  await sheets.spreadsheets.values.update({
    spreadsheetId: config.SHEET_ID,
    range: `${SHEET_NAME}!L5`,
    valueInputOption: "RAW",
    resource: { values }
  });
}

// 참가자 한 명 추가 (10모드용)
async function addParticipant(name) {
  const slots = await readParticipantsRaw();
  for (let i = 0; i < 10; i++) {
    if (!slots[i]) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.SHEET_ID,
        range: `${SHEET_NAME}!L${5 + i}`,
        valueInputOption: "RAW",
        resource: { values: [[name]] }
      });
      break;
    }
  }
}

// 참가자 한 명 제거 (10모드용)
async function removeParticipant(name) {
  const slots = await readParticipantsRaw();
  for (let i = 0; i < 10; i++) {
    if (slots[i] === name) {
      await sheets.spreadsheets.values.clear({
        spreadsheetId: config.SHEET_ID,
        range: `${SHEET_NAME}!L${5 + i}`
      });
      break;
    }
  }
}

// 10명 명단 전체 비우기
async function clear10List() {
  await sheets.spreadsheets.values.clear({
    spreadsheetId: config.SHEET_ID,
    range: RANGE_10P
  });
}

// 20명 명단 전체 비우기
async function clear20List() {
  await sheets.spreadsheets.values.clear({
    spreadsheetId: config.SHEET_ID,
    range: RANGE_20P
  });
}

// 20명 명단 채우기 (공통)
async function fill20List(allNames) {
  const values = allNames.map(n => [n]);

  await clear20List();

  await sheets.spreadsheets.values.update({
    spreadsheetId: config.SHEET_ID,
    range: `${SHEET_NAME}!L18`,
    valueInputOption: "RAW",
    resource: { values }
  });
}

// 20모드에서 한 명 추가
async function addParticipant20(name) {
  const slots = await read20Raw();
  for (let i = 0; i < 20; i++) {
    if (!slots[i]) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.SHEET_ID,
        range: `${SHEET_NAME}!L${18 + i}`,
        valueInputOption: "RAW",
        resource: { values: [[name]] }
      });
      break;
    }
  }
}

// 20모드에서 한 명 제거
async function removeParticipant20(name) {
  const slots = await read20Raw();
  for (let i = 0; i < 20; i++) {
    if (slots[i] === name) {
      await sheets.spreadsheets.values.clear({
        spreadsheetId: config.SHEET_ID,
        range: `${SHEET_NAME}!L${18 + i}`
      });
      break;
    }
  }
}

// 모집 메시지 갱신 (모드에 따라 다른 텍스트)
async function updateSignupMessage(channelId) {
  try {
    const msgId = signupMessages.get(channelId);
    if (!msgId) return;

    const channel = await client.channels.fetch(channelId);
    const msg = await channel.messages.fetch(msgId);

    const mode = getMode(channelId);
    let text;

    if (mode === "10") {
      const participantsRaw = await readParticipantsRaw();
      const participants = participantsRaw.filter(Boolean);
      const waiters = getWaitlist(channelId);

      text = baseText10();

      if (participants.length > 0) {
        text += `\n\n현재 참가자 (${participants.length}명):\n${participants.join(" ")}`;
      }
      if (waiters.length > 0) {
        text += `\n\n대기자 (${waiters.length}명):\n${waiters.join(" ")}`;
      }
    } else {
      const list20 = await read20Raw();
      const participants = list20.filter(Boolean);

      text = baseText20();

      if (participants.length > 0) {
        text += `\n\n현재 참가자 (${participants.length}명):\n${participants.join(" ")}`;
      }
    }

    await msg.edit({ content: text });
  } catch (err) {
    console.log("메시지 업데이트 오류:", err.message);
  }
}

// ===============================
client.login(BOT_TOKEN); // ✅ 환경변수에서 읽은 토큰으로 로그인
// ===============================
