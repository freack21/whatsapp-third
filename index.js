import {
    DisconnectReason,
    makeWASocket,
    useMultiFileAuthState,
    downloadMediaMessage,
    makeInMemoryStore,
    makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import * as fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import memeMaker from "meme-maker";
import axios from "axios";
import pino from "pino";

ffmpeg.setFfmpegPath("ffmpeg.exe");
const prefix = "-";
const logger = pino({ level: "silent" });

const store = makeInMemoryStore({ logger }) || undefined;
store?.readFromFile("./baileys_store_multi.json");

setInterval(() => {
    store?.writeToFile("./baileys_store_multi.json");
}, 10000);

async function getMessage(key) {
    if (store) {
        const msg = await store.loadMessage(key?.remoteJid, key?.id);
        return msg?.message || {};
    }

    // only if store is present
    return {};
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(
        "auth_info_baileys"
    );
    const sock = makeWASocket({
        printQRInTerminal: true,
        auth: {
            creds: state.creds,
            /** caching makes the store faster to send/recv messages */
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger,
        getMessage,
    });
    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === "close") {
            const shouldReconnect =
                new Boom(lastDisconnect.error)?.output?.statusCode !==
                DisconnectReason.loggedOut;
            console.log(
                "connection closed due to ",
                lastDisconnect.error,
                ", reconnecting ",
                shouldReconnect
            );
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === "open") {
            console.log("opened connection");
        }
    });
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async (messages) => {
        // console.log(JSON.stringify(messages, undefined, 2));

        const from = messages.messages[0]?.key?.remoteJid || "";
        const msg = messages.messages[0] || {};
        const content = JSON.stringify(msg.message);
        const type = Object.keys(msg.message || {})[0] || "";

        let body =
            type === "conversation" &&
            msg.message.conversation.startsWith(prefix)
                ? msg.message.conversation
                : type == "imageMessage" &&
                  msg.message.imageMessage.caption.startsWith(prefix)
                ? msg.message.imageMessage.caption
                : type == "videoMessage" &&
                  msg.message.videoMessage.caption.startsWith(prefix)
                ? msg.message.videoMessage.caption
                : type == "extendedTextMessage" &&
                  msg.message.extendedTextMessage.text.startsWith(prefix)
                ? msg.message.extendedTextMessage.text
                : "";
        let bodyArgs = body.split(" ");
        bodyArgs.splice(0, 1);
        bodyArgs = bodyArgs.join(" ");
        const command = body.slice(1).trim().split(/ +/).shift().toLowerCase();
        const args = body.trim().split(/ +/).slice(1);
        const isCmd = body.startsWith(prefix);
        sock.readMessages([msg.key]);

        const mentionByTag =
            type == "extendedTextMessage" &&
            msg.message.extendedTextMessage.contextInfo != null
                ? msg.message.extendedTextMessage.contextInfo.mentionedJid
                : [];
        const mentionByReply =
            type == "extendedTextMessage" &&
            msg.message.extendedTextMessage.contextInfo != null
                ? msg.message.extendedTextMessage.contextInfo.participant || ""
                : "";
        const mention =
            typeof mentionByTag == "string" ? [mentionByTag] : mentionByTag;
        mention != undefined ? mention.push(mentionByReply) : [];
        const mentionUser =
            mention != undefined ? mention.filter((n) => n) : [];

        const botNumber = sock.user.jid;
        const isGroup = from.endsWith("@g.us");
        const sender = isGroup ? msg.participant : msg.key.remoteJid;
        const groupMetadata = isGroup ? await sock.groupMetadata(from) : "";
        const groupName = isGroup ? groupMetadata.subject : "";
        // const totalchat = sock.chats.all();

        const getRandom = (ext) => {
            return `${Math.floor(Math.random() * 10000)}${ext || ""}`;
        };
        const saveMedia = async (path, data) => {
            fs.writeFileSync(path, data.toString("base64"), "base64");
        };
        const isUrl = (urls) => {
            return urls.match(
                new RegExp(
                    /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&/=]*)/,
                    "gi"
                )
            );
        };
        const reply = async (text) => {
            await sock.sendMessage(from, { text }, { quoted: msg });
        };
        const sendMsg = async (to, text) => {
            await sock.sendMessage(to, { text });
        };
        const mentions = async (text, members, isReply) => {
            !isReply
                ? await sock.sendMessage(from, {
                      text,
                      contextInfo: { mentionedJid: members },
                  })
                : await sock.sendMessage(
                      from,
                      { text, contextInfo: { mentionedJid: members } },
                      {
                          quoted: msg,
                      }
                  );
        };

        const isQuotedImage =
            type === "extendedTextMessage" && content.includes("imageMessage");
        const isQuotedVideo =
            type === "extendedTextMessage" && content.includes("videoMessage");
        const isQuotedDocument =
            type === "extendedTextMessage" &&
            content.includes("documentMessage");
        const isQuotedSticker =
            type === "extendedTextMessage" &&
            content.includes("stickerMessage");
        const isMedia =
            isQuotedImage ||
            isQuotedVideo ||
            isQuotedDocument ||
            isQuotedSticker ||
            type == "imageMessage" ||
            type == "documentMessage" ||
            type == "stickerMessage" ||
            type == "videoMessage";

        if (messages.type == "notify") {
            if (isCmd) await sendMsg(from, "⌛Loading..");
            switch (command) {
                case "stiker":
                case "s":
                case "sticker":
                    if (isMedia) {
                        const encmedia =
                            isQuotedImage ||
                            isQuotedVideo ||
                            isQuotedDocument ||
                            isQuotedSticker
                                ? JSON.parse(
                                      JSON.stringify(msg).replace(
                                          "quotedM",
                                          "m"
                                      )
                                  ).message.extendedTextMessage.contextInfo
                                : msg;
                        const buff = await downloadMediaMessage(
                            encmedia,
                            "buffer",
                            {}
                        );
                        let filepath = getRandom();
                        await saveMedia(filepath, buff);
                        const randomName = getRandom(".webp");
                        ffmpeg(`./${filepath}`)
                            .input(filepath)
                            .on("error", () => {
                                fs.unlinkSync(filepath);
                                reply(
                                    "Terjadi kesalahan saat meng-convert sticker."
                                );
                            })
                            .on("end", async () => {
                                if (bodyArgs) {
                                    let texts = bodyArgs.split("|");
                                    texts = texts.map((d) => d.trim());
                                    memeMaker(
                                        {
                                            image: randomName,
                                            outfile: randomName,
                                            topText: texts[0] || "",
                                            bottomText: texts[1] || "",
                                        },
                                        async function (err) {
                                            if (err) console.log(err);
                                            await sock.sendMessage(
                                                from,
                                                {
                                                    sticker: {
                                                        url: randomName,
                                                    },
                                                },
                                                { quoted: msg }
                                            );
                                            fs.unlinkSync(filepath);
                                            fs.unlinkSync(randomName);
                                        }
                                    );
                                } else {
                                    await sock.sendMessage(
                                        from,
                                        {
                                            sticker: {
                                                url: randomName,
                                            },
                                        },
                                        { quoted: msg }
                                    );
                                    fs.unlinkSync(filepath);
                                    fs.unlinkSync(randomName);
                                }
                            })
                            .addOutputOptions([
                                `-vcodec`,
                                `libwebp`,
                                `-vf`,
                                `scale='min(320,iw)':min'(320,ih)':force_original_aspect_ratio=decrease,fps=15, pad=320:320:-1:-1:color=white@0.0, split [a][b]; [a] palettegen=reserve_transparent=on:transparency_color=ffffff [p]; [b][p] paletteuse`,
                            ])
                            .toFormat("webp")
                            .save(randomName);
                    } else {
                        reply(
                            `Kirim gambar dengan caption ${prefix}sticker atau tag gambar yang sudah dikirim`
                        );
                    }
                    break;
                case "tiktok":
                case "tt":
                case "ttdl":
                case "dltt":
                    if (bodyArgs) {
                        let resultTT = await tt(bodyArgs);

                        if (resultTT.url) {
                            await sock.sendMessage(from, {
                                video: {
                                    url: resultTT.url,
                                },
                                caption: resultTT.text,
                            });
                        } else {
                            reply(`Gagal download video TikTok-mu. Maaf yaa`);
                        }
                    } else {
                        reply(
                            `Kirim link dengan caption ${prefix}tt <link> atau tag link yang sudah dikirim`
                        );
                    }
                    break;
                case "tiktokmp3":
                case "tiktokaudio":
                case "ttmp3":
                case "ttaudio":
                case "audiott":
                    if (bodyArgs) {
                        let resultTT = await tt(bodyArgs, true);

                        if (resultTT.url) {
                            await sock.sendMessage(from, {
                                audio: {
                                    url: resultTT.url,
                                },
                            });
                        } else {
                            reply(`Gagal download audio TikTok-mu. Maaf yaa`);
                        }
                    } else {
                        reply(
                            `Kirim link dengan caption ${prefix}tt <link> atau tag link yang sudah dikirim`
                        );
                    }
                    break;
                case "instagram":
                case "insta":
                case "ig":
                case "igdl":
                case "dlig":
                    if (bodyArgs) {
                        let resultIG = await ig(bodyArgs);

                        if (resultIG.urls && resultIG.urls.length) {
                            for (const url of resultIG.urls) {
                                let content = {
                                    video: {
                                        url,
                                    },
                                };
                                if (
                                    url.includes(".jpg") ||
                                    url.includes(".png")
                                ) {
                                    content = {
                                        image: {
                                            url,
                                        },
                                    };
                                } else if (url.includes(".webp")) {
                                    content = {
                                        sticker: {
                                            url,
                                        },
                                    };
                                }
                                await sock.sendMessage(from, content);
                            }
                        } else {
                            reply(`Gagal download video TikTok-mu. Maaf yaa`);
                        }
                    } else {
                        reply(
                            `Kirim link dengan caption ${prefix}tt <link> atau tag link yang sudah dikirim`
                        );
                    }
                    break;
            }
        }
    });
}

const tt = async (url, isMp3) => {
    return new Promise((resolve, reject) => {
        axios
            .get(`http://23.95.48.230:2121/tt?url=${url}`)
            .then(async (response) => {
                let data = response.data;
                const text = data.desc;
                let url = data.mp4_1 || data.mp4_hd || data.mp4_2;
                if (isMp3) url = data.mp3;
                resolve({
                    text,
                    url,
                });
            })
            .catch((err) => {
                console.log(err);
                resolve({ err });
            });
    });
};

const ig = async (url) => {
    return new Promise((resolve, reject) => {
        axios
            .get(`http://23.95.48.230:2121/ig?url=${url}`)
            .then(async (response) => {
                let data = response.data;
                resolve({
                    urls: data.links,
                });
            })
            .catch((err) => {
                console.log(err);
                resolve({ err });
            });
    });
};

connectToWhatsApp();
