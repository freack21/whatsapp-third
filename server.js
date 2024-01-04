import {
    DisconnectReason,
    makeWASocket,
    useMultiFileAuthState,
    downloadMediaMessage,
    makeInMemoryStore,
    makeCacheableSignalKeyStore,
    delay,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import * as fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import memeMaker from "meme-maker";
import axios from "axios";
import pino from "pino";
import NodeCache from "node-cache";

// ffmpeg.setFfmpegPath("ffmpeg.exe");
const prefix = "-";
const logger = pino({ level: "silent" });

const msgRetryCounterCache = new NodeCache();
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
        msgRetryCounterCache,
        logger,
        getMessage,
    });

    const sendMessageWTyping = async (jid, msg, opt) => {
        await sock.presenceSubscribe(jid);
        await delay(500);

        await sock.sendPresenceUpdate("composing", jid);
        await delay(1000);

        await sock.sendPresenceUpdate("paused", jid);

        await sock.sendMessage(jid, msg, opt);
    };

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

        if (messages.type != "notify") return;
        for (const msg of messages.messages) {
            const from = msg?.key?.remoteJid || "";
            const content = JSON.stringify(msg.message);
            let type = Object.keys(msg.message || {});
            type =
                type.filter(
                    (d) =>
                        !d.includes("ContextInfo") &&
                        !d.includes("KeyDistribution")
                )[0] || "";
            // console.log(type);

            const futureMsg = msg.message[type]?.message || null;
            // : futureMsg
            // ? futureMsg.imageMessage &&
            //   (futureMsg.imageMessage.caption.startsWith(prefix)
            //       ? futureMsg.imageMessage.caption
            //       : futureMsg.videoMessage.caption.startsWith(
            //             prefix
            //         )
            //       ? futureMsg.videoMessage.caption
            //       : "")

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
                    : type == "documentMessage" &&
                      msg.message.documentMessage.caption.startsWith(prefix)
                    ? msg.message.documentMessage.caption
                    : type == "extendedTextMessage" &&
                      msg.message.extendedTextMessage.text.startsWith(prefix)
                    ? msg.message.extendedTextMessage.text
                    : "";
            let bodyArgs = body.split(" ");
            bodyArgs.splice(0, 1);
            bodyArgs = bodyArgs.join(" ");
            const command = body
                .slice(1)
                .trim()
                .split(/ +/)
                .shift()
                .toLowerCase();
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
                    ? msg.message.extendedTextMessage.contextInfo.participant ||
                      ""
                    : "";
            const mention =
                typeof mentionByTag == "string" ? [mentionByTag] : mentionByTag;
            mention != undefined ? mention.push(mentionByReply) : [];
            const mentionUser =
                mention != undefined ? mention.filter((n) => n) : [];

            const botNumber = sock.user.jid;
            const isGroup = from.endsWith("@g.us");
            const sender = isGroup
                ? msg.participant || msg.key?.participant
                : msg.key.remoteJid;
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
                await sendMessageWTyping(from, { text }, { quoted: msg });
            };
            const sendMsg = async (to, text) => {
                await sendMessageWTyping(to, { text });
            };
            const mentions = async (text, members, isReply) => {
                !isReply
                    ? await sendMessageWTyping(from, {
                          text,
                          contextInfo: { mentionedJid: members },
                      })
                    : await sendMessageWTyping(
                          from,
                          { text, contextInfo: { mentionedJid: members } },
                          {
                              quoted: msg,
                          }
                      );
            };

            const isQuotedImage =
                type === "extendedTextMessage" &&
                content.includes("imageMessage");
            const isQuotedVideo =
                type === "extendedTextMessage" &&
                content.includes("videoMessage");
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

            let isQuoutedViewOnce =
                msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            isQuoutedViewOnce = Object.keys(isQuoutedViewOnce || {});
            isQuoutedViewOnce = isQuoutedViewOnce.map((d) => d.toLowerCase());
            isQuoutedViewOnce = isQuoutedViewOnce
                .join(",")
                .includes("viewonce");
            let quotedMsg = null;
            let qoutedMsgType = null;
            if (isQuoutedViewOnce) {
                quotedMsg =
                    msg.message?.extendedTextMessage?.contextInfo
                        ?.quotedMessage;
                qoutedMsgType = Object.keys(quotedMsg || {})[0];
                quotedMsg = quotedMsg[qoutedMsgType].message;
                qoutedMsgType = Object.keys(quotedMsg || {})[0];
            }

            if (isCmd) await reply("⌛Loading..");
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
                                            await sendMessageWTyping(
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
                                    await sendMessageWTyping(
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
                            await sendMessageWTyping(from, {
                                video: {
                                    url: resultTT.url,
                                },
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
                            await sendMessageWTyping(from, {
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
                                await sendMessageWTyping(from, content);
                            }
                        } else {
                            reply(`Gagal download video IG-mu. Maaf yaa`);
                        }
                    } else {
                        reply(
                            `Kirim link dengan caption ${prefix}ig <link> atau tag link yang sudah dikirim`
                        );
                    }
                    break;
                case "facebook":
                case "fb":
                case "fbdl":
                case "dlfb":
                    if (bodyArgs) {
                        let resultFB = await fb(bodyArgs);

                        if (resultFB.links && resultFB.links[0]) {
                            const url = resultFB.links[0];
                            let content = {
                                video: {
                                    url,
                                },
                            };
                            if (url.includes(".jpg") || url.includes(".png")) {
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
                            await sendMessageWTyping(from, content);
                        } else {
                            reply(`Gagal download video FB-mu. Maaf yaa`);
                        }
                    } else {
                        reply(
                            `Kirim link dengan caption ${prefix}fb <link> atau tag link yang sudah dikirim`
                        );
                    }
                    break;
                case "show":
                case "reveal":
                    if (isQuoutedViewOnce) {
                        quotedMsg[qoutedMsgType].viewOnce = false;
                        await sock.sendMessage(sender, {
                            forward: {
                                key: msg.message.extendedTextMessage.contextInfo
                                    ?.stanzaId,
                                message: quotedMsg,
                            },
                            force: true,
                        });
                    } else {
                        reply(
                            `Balas pesan sekali lihat dengan caption ${prefix}reveal`
                        );
                    }
                    break;
                case "cekportal":
                case "portal":
                    if (
                        (!bodyArgs && !bodyArgs.includes("niu")) ||
                        (!sender.includes("86230830") &&
                            bodyArgs &&
                            (bodyArgs.includes("k5VkamhjZptpaQ") ||
                                !bodyArgs.includes("niu")))
                    ) {
                        return reply(
                            "Maaf, gunakan params anda sendiri dengan :\n\n-portal params"
                        );
                    }
                    let resultPortal = await portalScrap(bodyArgs);

                    if (!resultPortal.error) {
                        // await reply(JSON.stringify(resultPortal, null, 2));
                        await reply(wrapToList(resultPortal));
                    } else {
                        reply(
                            resultPortal.msg ||
                                resultPortal.message ||
                                "Gagal scraping portal-mu. Maaf yaa"
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

const fb = async (url) => {
    return new Promise((resolve, reject) => {
        axios
            .get(`http://23.95.48.230:2121/fb?url=${url}`)
            .then(async (response) => {
                let { links, text } = response.data;
                resolve({
                    links,
                    text,
                });
            })
            .catch((err) => {
                console.log(err);
                resolve({ err });
            });
    });
};

const portalScrap = async (args) => {
    const [params, sesi] = args ? args.split("|") : ["", ""];
    return new Promise((resolve, reject) => {
        axios
            .get(
                `http://23.95.48.230:4062/${
                    params.startsWith("?") ? params : ""
                }`,
                {
                    params: { sesi },
                }
            )
            .then(async (response) => {
                resolve(response.data);
            })
            .catch((error) => {
                resolve({ error });
            });
    });
};

const wrapToList = (data) => {
    let res = "";
    for (const d of data.nilai) {
        res += `${d.Nama} : ${d.Nilai || "-"} | ${d.SKS} | ${d["Nilai SKS"]}\n`;
    }
    res += "----------------\n";
    for (const d in data.sum) {
        res += `${d} : ${data.sum[d]}\n`;
    }

    return res.trim();
};

connectToWhatsApp();
