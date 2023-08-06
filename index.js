//"use strict" // Causes memory issues in Heroku free plan
require('dotenv').config();
const numCPUs = require('os').cpus().length
console.log(`Number of CPUs is: ${numCPUs}`)

function toBoolean(x) {
    if (typeof x === 'object') {
      for (var i in x) return true
      return false
    }
    return (x !== null) && (x !== undefined) && !['false', '', '0', 'no', 'off'].includes(x.toString().toLowerCase())
}

const telegramToken = process.env.telegramToken ?? 0
const inst = process.env.inst ?? 0
const host = process.env.host ?? "Host"
const totalInst = process.env.totalInst ?? 0
const activeInst = process.env.activeInst ?? "0@Host" //unused for now
const instActivetUntil = process.env.instActiveUntil ?? "🤷"
const branch = process.env.branch ?? "staging"
const debugging = toBoolean(process.env.debugging)
const devChatId = process.env.devChatId ?? 0  // the group ID of development team on Telegram
const codeVer = process.env.npm_package_version ?? "1970.1.1-0"



// Use log(x) instead of log(x) to control debugging mode from env variables
// Use log(x, e) for errors
function log(x, e){
    return new Promise ((resolve, reject) =>{
        switch(log.arguments.length){
            case 1:
                if(debugging) console.log(x)
                resolve()
                break
            case 2:
                console.error(x, e)
                if(bot) {
                    bot.telegram.sendMessage(devChatId, (x+(JSON.stringify(e))).substring(0, 4096))
                        .then(resolve())
                        .catch(er => {
                            console.error(`Error while sending log to devChat: `, er)
                            resolve()
                        })
                }
                break
            default:
                console.error('Invalid log argument count.')
                resolve()
                break
        }
    })
}


function instStateMsg(){
  return `DailyAyaTelegram ${branch} instance ${inst}@${host} (of total ${totalInst}) is active in ${
    debugging ? 'debugging' : 'normal'} mode of version ${codeVer} until ${instActivetUntil}.\n
Memory Used: ${Math.floor(process.memoryUsage().rss / (1024 * 1024))} MB\n
Uptime: ${+(process.uptime()/3600).toFixed(2)} hours`
}


// just for web to manage sleep and balance between multiple instances
const express = require('express')
const expressApp = express()
const port = process.env.PORT ?? 3001

// main route will respond instStateMsg when requested.
// we call it every 15 minutes using a google app script to prevent the app from sleeping.
expressApp.get('/', (req, res) => {
  res.send(instStateMsg())
})
expressApp.listen(port, () => {
  log(`Listening on port ${port}`)
})





// MongoDB is a pool and always open
var dbConn
const { MongoClient, ServerApiVersion } = require('mongodb')
const mongoDbUser = process.env.mongoDbUser
const mongoDbPass = process.env.mongoDbPass
const mongoSubdomain = process.env.mongoSubdomain
const uri = `mongodb+srv://${mongoDbUser}:${mongoDbPass}@cluster0.${mongoSubdomain}.mongodb.net/?retryWrites=true&w=majority&maxPoolSize=50&keepAlive=true`

const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 })
log('Connecting to MongoDB...')
client.connect((err, db) => {
    if (err) log('MongoDbConn ERROR: ', err)
    else {
        log('MongoDbConn Connected!')
        dbConn = db

        timerSend()
            .catch(e => {
                log(`Error while calling timerSend inside dbConn: `, e)
            })
    }
})




// Records the last time an aya was sent to a chat so we can send again periodically (daily, for example)
function lastAyaTime(chatId, status, chatName, chatType, lang, trigger){
    var setObj = {}
    status = status ?? "success" // Function can be called with chatId only if not blocked
    
    setObj.since = {$cond: [{$not: ["$since"]}, new Date(), "$since"]} // Add "Since" date only once
    setObj.lastAyaTime = Date.now()
    setObj.blocked = status.toLowerCase().includes('block')
    if(chatName) setObj.name = chatName // Only update the name when it's known
    if(lang) setObj.language_code = lang // Only update the language_code when it's known
    if(chatType) setObj.chatType = chatType // Only update the chatType when it's known
    if(trigger){
        setObj.lastTrigger = trigger
        switch (trigger) {
            case 'surprise':
                setObj.surprises = {$cond: [{$not: ["$surprises"]}, 1, {$add: ["$surprises", 1]}]}
                break;

            case 'next':
                setObj.nexts = {$cond: [{$not: ["$nexts"]}, 1, {$add: ["$nexts", 1]}]}
                break;

            case 'request':
                setObj.requests = {$cond: [{$not: ["$requests"]}, 1, {$add: ["$requests", 1]}]}
                break;

            case 'timer':
                setObj.timers = {$cond: [{$not: ["$timers"]}, 1, {$add: ["$timers", 1]}]}
                break;
            
            default:
                log('Unknown trigger: ', trigger)
                break;
        }
    }

    dbConn.db('dailyAyaTelegram').collection('chats').updateOne(
        {chatId: chatId},
        [{$set: setObj}],
        {upsert: true}
    ).then(log('Recorded Last Aya Time for chat '+chatId+' as '+ (setObj.blocked ? "blocked." : "successfuly sent.")))
    .catch(e => log('Failed to record Last Aya Time for chat '+chatId+': ', e))
}


// Sets the favorit reciter for chatIds that request so
function setFavReciter(chatId, reciterIdentifier){
    var setObj = {}
    log(`Chat ${chatId} fav reciter request: ${reciterIdentifier}`)

    // sets reciter to "surprise" if not provided or reciter is not valid
    reciterIdentifier = (reciterIdentifier == "surprise" || isValidReciter(reciterIdentifier)) ? reciterIdentifier : "surprise"
    log(`Chat ${chatId} fav reciter to be stored: ${reciterIdentifier}`)
    
    setObj.favReciter = reciterIdentifier

    dbConn.db('dailyAyaTelegram').collection('chats').updateOne(
        {chatId: chatId},
        [{$set: setObj}],
        {upsert: true}
    )
    .then(() => {
        log(`Favorit reciter "${reciterIdentifier}" has been set for chat ${chatId}.`)

        var msg
        if (reciterIdentifier == "surprise") {
            msg = 
`Чтец будет меняться с каждым новым аятом`
        } else {
            var requestedFavReciterData = arReciters.filter(i => i.identifier == reciterIdentifier)
            msg =
`Текущий любимый чтец: ${requestedFavReciterData[0].englishName}`
        }
        bot.telegram.sendMessage(chatId, msg, {
            reply_markup: {
                inline_keyboard:[
                    [{
                        text: "🎁",
                        callback_data: "surpriseAya"
                    }]
                ]
            }
        })
    })
    .catch(e => {
        log(`Error while setting favorit reciter "${reciterIdentifier}" for chat ${chatId}:`, e)
        msg =
`عذرا.. نواجه مشكلة أثناء حفظ القارئ المفضل ونأمل حلها قريبا.

Sorry.. There's an issue while setting favorite reciters and we hope it gets fixed soon.` 
        bot.telegram.sendMessage(chatId, msg, {
            reply_markup: {
                inline_keyboard:[
                    [{
                        text: "🎁",
                        callback_data: "surpriseAya"
                    }]
                ]
            }
        }).catch(er => log(`Error while sending sorry for failing to set fav reciter: `, er))
    })
}

// Gets the favorit reciter for chatIds requesting surprise Aya
function getFavReciter(chatId){
    return new Promise ((resolve, reject) => {
        log(`Getting fav reciter for Chat ${chatId}`)
        if (chatId){
            dbConn.db('dailyAyaTelegram').collection('chats').find({chatId: chatId}).toArray((err, res) => {
                if (err){
                    log(`Error while getting favReciter for chat ${chatId}: `, err)
                    reject(err)
                } else {
                    resolve(res[0]?.favReciter ?? 0) // Resolve with favReciter if it exists, or 0 if not
                }
            })
        } else {
            resolve(0)
        }
    })
}



//timer to fetch database every 15 minutes to send aya every 24 hours to chats who didn't block the bot.
const checkMinutes = process.env.TimerCheckMinutes ?? 15 // That means checking database every 15 minutes
const sendHours = process.env.TimerSendHours ?? 24 // That means sending an Aya every 24 hours, for example
const checkMillis = checkMinutes * 60 * 1000
const sendMillis = (sendHours * 60 * 60 * 1000)-checkMillis // For example, (24 hours - 15 minutes) to keep each chat near the same hour, otherwise it will keep shifting

function timerSend(){
    return new Promise((resolve, reject) =>{
        try {
            dbConn.db('dailyAyaTelegram').collection('chats').find({lastAyaTime: {$lte: Date.now()-sendMillis}, blocked: false}).toArray( (err, res) => {
                if (err) {
                    log('Timer dbConn error: ', err)
                    reject(err)
                } else {
                    log(`Used memory: ${Math.floor(process.memoryUsage().rss / (1024 * 1024))} MB`)
			
			// removed this warning as we spread sending by putting a 50ms delay between each message (20 msg/sec)
                    // if(res.length > 20) log('Warning: Almost reaching Telegram sending limits. Max is 30 users/sec. Current: ', res.length)
			
                    log(`Timer will send to ${res.length} chats.`)
                    res.forEach((chat, index) => {
			    setTimeout(() => {
				    sendAya(chat.chatId, "", chat.favReciter, "", 'timer')
			    }, 50 * index) // 50ms delay between messages for 20 msg/sec
		    })
                    resolve()
                }
            })
        } catch (e) {
            if (!e.message.includes(`Cannot read property 'db'`)){
                log('Timer unexpected error: ', e)
            }
            reject(e)   
        }
    })
}

// Delay first timerSend until next quarter hour
const timerNow = new Date()
const timerFirstDelay = (15 - timerNow.getMinutes() % 15) * 60 * 1000 - timerNow.getSeconds() * 1000 - timerNow.getMilliseconds()
setTimeout(() => {
  timerSend()
  // Call timerSend every 15 minutes after the first execution
  const dailyTimer = setInterval(timerSend, checkMillis)
}, timerFirstDelay)






// Using Telegraf NodeJS framework for Telegram bots
const {Telegraf} = require('telegraf')
const bot = new Telegraf(telegramToken)
bot.telegram.getMe().then((botInfo) => { // for handling group commands without calling "launch"
    bot.options.username = botInfo.username
})



// Inform Dev group about the instance state
if(telegramToken){
    bot.telegram.sendMessage(devChatId, instStateMsg())
        .catch(er => log(`Error while sending instance state: `, er))
}




async function start(chatId){
    var msg = 
`Бот для поиска аятов по номерам сур и аятов
Для доступных команд:

/commands`

    bot.telegram.sendMessage(chatId, msg, {
        reply_markup: {
            inline_keyboard:[
                [{
                    text: "🎁",
                    callback_data: "surpriseAya"
                }]
            ]
        }
    })
	.then(c => successSend(c, 0, "", "request"))
    .catch(e => log("Error while sending start: ", e))
    summaryStats()
}

async function summaryStats(){
    // Informing "DailyAya Dev" of total active and blocked chats when /start is called by any user
    try {
        var privateActiveChats = await dbConn.db('dailyAyaTelegram').collection('chats').countDocuments({blocked: false, chatType: "private"})
        var otherActiveChats = await dbConn.db('dailyAyaTelegram').collection('chats').countDocuments({blocked: false, chatType: {$ne: "private"}})
        var totalBlockedChats = await dbConn.db('dailyAyaTelegram').collection('chats').countDocuments({blocked: true})
        var totalChatsMsg = `Total Active: ${privateActiveChats+otherActiveChats}   Blocked: ${totalBlockedChats}\n`
                            + `Private Active: ${privateActiveChats}    Others: ${otherActiveChats}`
        log(totalChatsMsg)

        bot.telegram.sendMessage(devChatId, totalChatsMsg)
        .catch(err => log(`Error while sending active stats: `, err))
    } catch (e) {
        log('Error while getting total chats: ', e)
    }
}





// Returns a random number based on input
// if no input or input is "aya": a random aya number in the whole quran (1 to 6236)
// if input is "reciter": a random number representing one of the available reciters
function random(type){
    var max = 6236 // default for aya number
    if (type == "reciter"){
        max = arReciters.length
        return arReciters[Math.floor(Math.random() * Math.floor(max))].identifier
    }
    // +1 because the generated numbers are between 0 and max-1
    else return Math.floor(Math.random() * Math.floor(max)) + 1  
}





const axios         = require('axios')
const arQuran       = require('./quran-uthmani.json').data.surahs
const ruQuran       = require('./ru.kuliev.json').data.surahs
const arReciters    = require('./audio.json').data.filter(i => i.language == "ar")

function checkSource(){
    var downloadStart = process.uptime()
    axios("http://api.alquran.cloud/v1/quran/quran-uthmani")
    .then(r =>{
        if(JSON.stringify(r.data.data.surahs) != JSON.stringify(arQuran)){
            bot.telegram.sendMessage(devChatId,
                `Remote arQuran has changed. Please update the cached JSON file.`
            ).catch(er => log(`Error while sending arQuran change: `, er))
        } else {
            log(`Remote arQuran is the same as the cached JSON file. It took ${((process.uptime()-downloadStart)).toFixed(2)} seconds.`)
        }
    })
    .catch(e => log('Error while comparing arQuran cached vs remote: ', e))

    axios("http://api.alquran.cloud/v1/quran/en.ahmedraza")
    .then(r =>{
        if(JSON.stringify(r.data.data.surahs) != JSON.stringify(ruQuran)){
            bot.telegram.sendMessage(devChatId,
                `Remote ruQuran has changed. Please update the cached JSON file.`
            ).catch(er => log(`Error while sending ruQuran change: `, er))
        } else {
            log(`Remote ruQuran is the same as the cached JSON file. It took ${((process.uptime()-downloadStart)).toFixed(2)} seconds.`)
        }
    })
    .catch(e => log('Error while checking ruQuran cached vs remote: ', e))

    axios("http://api.alquran.cloud/edition/format/audio")
    .then(r =>{
        if(JSON.stringify(r.data.data.filter(i => i.language == "ar")) != JSON.stringify(arReciters)){
            bot.telegram.sendMessage(devChatId,
                `Remote arReciters has changed. Please update the cached JSON file.`
            ).catch(er => log(`Error while sending arReciters change: `, er))
        } else {
            log(`Remote arReciters is the same as the cached JSON file. It took ${((process.uptime()-downloadStart)).toFixed(2)} seconds.`)
        }
    })
    .catch(e => log('Error while checking arReciters cached vs remote: ', e))
}
if(!debugging) {
    checkSource()
}


function ayaId2suraAya(ayaId){
    var sura = 0,
        aya = 0
    if(1 <= ayaId && ayaId <= 6236){
        sura = ruQuran.find(s => s.ayahs.find(a => a.number == ayaId)).number
        aya = ruQuran[sura-1].ayahs.find(a => a.number == ayaId).numberInSurah
    }
    return {sura: sura, aya: aya} // Returns {sura: 0, aya: 0} if not valid ayaId
}

function suraAya2ayaId(suraAya){ // suraAya = {sura: suraNum, aya: ayaNum}
    var sura    = suraAya.sura,
        aya     = suraAya.aya,
        ayaId
    
    if (1 <= sura && sura <= 114){
        var ayaData = ruQuran[sura-1].ayahs.find(a => a.numberInSurah == aya)
        ayaId = ayaData ? ayaData.number : 0 // return 0 if valid Sura but invalid Aya
    } else {
        ayaId = -1 // return -1 if invalid Sura
    }
    
    return ayaId
}


// Prepare an Aya to be sent
function prepareAya(ayaId){
    String.prototype.toArNum = function() {return this.replace(/\d/g, d =>  '٠١٢٣٤٥٦٧٨٩'[d])}

    var ayaIndex    = ayaId2suraAya(ayaId),
        suraNum     = ayaIndex.sura,
        ayaNum      = ayaIndex.aya,

        arAya               = arQuran[suraNum-1].ayahs[ayaNum-1].text,
        enTranslatedAya     = ruQuran[suraNum-1].ayahs[ayaNum-1].text,
        arName              = ruQuran[suraNum-1].name.substr(8), // substr(8) to remove the Arabic word "Sura".
        enArName            = ruQuran[suraNum-1].englishName,
        enTranslatedName    = ruQuran[suraNum-1].englishNameTranslation,
        arIndex             = `﴿<a href="t.me/${bot.options.username}?start=${suraNum}-${ayaNum}">${arName}؜ ${ayaNum.toString().toArNum()}</a>﴾`,
        enIndex             = `<a href="t.me/${bot.options.username}?start=${suraNum}-${ayaNum}">"${enArName}: ${enTranslatedName}", Сура ${suraNum} Аят ${ayaNum}</a>`,
        
        arText              = `<b>${arAya}</b>\n${arIndex}`,
        enText              = `${enTranslatedAya}\n<i>{Смысловой перевод ${enIndex}}</i>`

    return {arText: arText, enText: enText}
}




// For inline keyboard when setting favorite reciter
var recitersInlineButtons = []
function recitersButtons(reciters){
    reciters.forEach(reciter => {
        recitersInlineButtons.push([{
            text: `${reciter.englishName} ${reciter.name}`,
            callback_data: `{"setReciter": "${reciter.identifier}"}`
        }])
    })
}
recitersButtons(arReciters)

// returns a URL string for the audio file of the requested aya (is a must)
// if reciter is not requested or not supported, a random reciter will be provided
// Must be called with .then .catch
var recitationTries = [] // ['aya/reciter']
function recitation(aya, reciter){
    return new Promise((resolve, reject) => {
        
        reciter = isValidReciter(reciter) ? reciter : random('reciter')

        axios(`http://api.alquran.cloud/ayah/${aya}/${reciter}`)
            .then(res => {
                recitationTries = recitationTries.filter(i => i != `${aya}/${reciter}`) // Remove from tries due to success
                var allAudio = [res.data.data.audio].concat(res.data.data.audioSecondary)
                audioPicker(allAudio, 0)
                .then(pick => resolve(pick))
                .catch(e => reject(e))
            }).catch(e => {
                log('Recitation Error: ', e)
                recitationTries.push(`${aya}/${reciter}`)
                if (recitationTries.filter(`${aya}/${reciter}`).length <= 3) {
                    setTimeout(
                        recitation(aya, reciter)
                        .then(r => resolve(r))
                        .catch(e => log("Recitattion Try Error: ", e)), // Don't reject inside loop
                        1000);
                } else {
                    recitationTries = recitationTries.filter(i => i != `${aya}/${reciter}`) // Remove from tries due to max tries
                    reject(e)
                }
            })
    })
}


function isValidReciter(reciter){
    var validReciter = false
    for (let i = 0; i < arReciters.length; i++) {
        if(arReciters[i].identifier == reciter) {
            validReciter = true
            break
        }
    }
    return validReciter
}



function audioPicker(audioUrlArray, i){
    return new Promise((resolve, reject) =>{
        audioUrlCheck(audioUrlArray[i])
            .then(isAvailable =>{
                if(isAvailable) resolve(audioUrlArray[i])
                else if (i+1 < audioUrlArray.length){
                    audioPicker(audioUrlArray, i+1)
                    .then(pick => resolve(pick))
                    .catch(e => reject(e))
                } else reject ('All audio files are not available.')
            })
            .catch(e => log("AuidoPicker Error: ", e)) // Don't reject inside the loop until it finishes
    })
}


function audioUrlCheck(url){
    return new Promise((resolve, reject) =>{
        axios.head(url)
        .then(r =>{
            log('Fetched audio file URL headers.')
            // log(`Audio URL header: ${JSON.stringify(r.headers)}`)
            if(r.status >= 200 && r.status < 300) resolve(true)
            else {
                log(`Error in audio file "${url}" header: `, r.headers)
                resolve(false)
            }
        })
        .catch(e => resolve(false)) // No reject if URL request failed
    })
}



// Send random Aya and random reciter if called with the userId argument only
function sendAya(chatId, ayaId, reciter, lang, trigger, withRecitation){
    log(`Initiating sending an Aya to chat ${chatId} with requested reciter: ${reciter ? reciter : "None"}`)

    ayaId = ayaId || random('aya')
    withRecitation = withRecitation || false

    sendAyaText(chatId, ayaId, reciter, lang, trigger)
        .then((ctx) => {
            if (withRecitation) {
                sendAyaRecitation(ctx, ayaId, reciter)
            }
        })
        .catch(e => {
            log(`Error while sending Aya ${ayaId} text to chat ${chatId}: `, e)
			let asBlocked = /blocked by the user|user is deactivated|need administrator rights/
                if(asBlocked.test(JSON.stringify(e))){
                    lastAyaTime(chatId, 'blocked')
                }
        })
}



function sendAyaText(chatId, ayaId, reciter, lang, trigger){
    return new Promise ((resolve, reject) => {
        log(`Formatting Aya ${ayaId} for chat ${chatId}`)
        reciter = reciter ? reciter : "None"
        var preparedAya = prepareAya(ayaId), // Prepare Aya text
            ayaDualText = `${preparedAya.arText}\n\n${preparedAya.enText}`, // Add an empty line between Arabic and English Aya text
            buttons = aMenuButtons("t0", ayaId, reciter) // Prepare buttons to be sent with Aya text

        // send aya text and inline buttons
        bot.telegram.sendMessage(chatId, ayaDualText, {
            disable_web_page_preview: true,
            disable_notification: true,
            parse_mode: 'HTML',
            reply_markup: buttons
        })
            .then(c => {
                successSend(c, ayaId, lang, trigger)
                resolve(c)
            })
            .catch(e => {
                if (e.response.description.includes('upgraded to a supergroup')){
                    sendAyaText(e.response.parameters.migrate_to_chat_id, ayaId, reciter, lang, trigger)
                    lastAyaTime(chatId, 'blocked')
                } else {
                    reject(e)
                }
            })
    })
}



function sendAyaRecitation(ctx, ayaId, reciter){
    return new Promise ((resolve, reject) => {
        var audioSuccess, favReciterReady, recitationReady, buttons, chatId = ctx.chat.id
        getFavReciter(isValidReciter(reciter) ? 0 : chatId) // getFavReciter will resolve 0 if there's a valid reciter
            .then(favReciter => {
                favReciterReady = true
                reciter = isValidReciter(favReciter || "None") ? favReciter : (isValidReciter(reciter) ? reciter : random('reciter'))
                log(`Chat ${chatId} got reciter: ${reciter}`)
                var suraAyaIndex        = ayaId2suraAya(ayaId),
                    recitationCaption   = 
                    `<a href="t.me/${bot.options.username}?start=${suraAyaIndex.sura}-${suraAyaIndex.aya}">@${
                        bot.options.username} ➔ ${suraAyaIndex.sura}:${suraAyaIndex.aya}</a>`
                buttons = aMenuButtons("r0", ayaId, reciter)
                recitation(ayaId, reciter)
                    .then(recitationUrl => {
                        recitationReady = true
                        bot.telegram.sendAudio(chatId, recitationUrl, {caption: recitationCaption, parse_mode: 'HTML', disable_notification: true})
                            .then((c) =>{
                                audioSuccess = true
                                var message_id = ctx.message_id || ctx.update.callback_query.message.message_id
                                if (c.message_id != 1 + message_id){ // Refer/Reply to the text if the recitation is not sent right after it
                                    audioSuccess = false
                                    bot.telegram.deleteMessage(chatId, c.message_id)
                                        .then (() => {
                                            bot.telegram.sendAudio(chatId, recitationUrl, {
                                                reply_to_message_id: message_id,
                                                caption: recitationCaption, parse_mode: 'HTML', disable_notification: true
                                            })
                                                .then((r) => {
                                                    audioSuccess = true
                                                    bot.telegram.editMessageReplyMarkup(chatId, message_id, null, null)
                                                        .then (() => {
                                                            bot.telegram.editMessageReplyMarkup(chatId, r.message_id, null, aMenuButtons("r0", ayaId, reciter))
                                                                .then(() => resolve(r))
                                                                .catch(er => log(`Error while adding recitation reply buttons: `, er))
                                                        }).catch(er => log(`Error while deleting text buttons after reply: `, er))
                                                }).catch(er => log(`Error while resending recitation: `, er))
                                        })
                                } else {
                                    bot.telegram.editMessageReplyMarkup(chatId, message_id, null, null)
                                        .then (() => {
                                            bot.telegram.editMessageReplyMarkup(chatId, c.message_id, null, aMenuButtons("r0", ayaId, reciter))
                                                .then(() => resolve(c))
                                                .catch(er => log(`Error while adding recitation buttons: `, er))
                                        }).catch(er => log(`Error while deleting text buttons: `, er))
                                }
                            })
                            .catch(e => {
                                log(`Error while sending recitation for aya ${ayaId} by ${reciter} to chat ${chatId}: `, e)
                                if(JSON.stringify(e).includes('blocked by the user')) {
                                    lastAyaTime(chatId, 'blocked')
                                } else if(!audioSuccess) {
                                    sendSorry(chatId, 'audio')
                                }
                                reject(e)
                            })
                    })
                    .catch(e => {
                        log(`Error while getting recitation URL for aya ${ayaId} by ${reciter} for chat ${chatId}: `, e)
                        if(!recitationReady) {
                            sendSorry(chatId, 'audio')
                        }
                        reject(e)
                    })
            })
            .catch(e => {
                log(`Error while calling getFavReciter for chat ${chatId}: `, e)
                if (!favReciterReady){
                    sendAyaRecitation(ctx, ayaId, "random") // try again with a random reciter
                }
            })
    })
}

function aMenuButtons(menuState, ayaId, reciter){
    var buttons = {inline_keyboard: [[{
        text: menuState.includes("0") ? "···" : "•••",
        callback_data: `{"aMenu":"${menuState}","a":${ayaId},"r":"${reciter}"}`
    }]]}

    

    if (menuState.includes("1")){
        var ayaIndex = ayaId2suraAya(ayaId)
        buttons.inline_keyboard[0].push({
            text: "⚠️",
            callback_data: `{"aReport":${ayaId},"r":"${reciter}"}`
        })
        if (menuState == "r1") { // Show setReciter button only when it's a menu of a recitation
            buttons.inline_keyboard[0].push({
                text: "🗣️",
                callback_data: `{"setReciter":"${reciter}","a":${ayaId}}`
            })
        }
        buttons.inline_keyboard[0].push({
            text: "📖",
            url: `https://quran-online.ru/${ayaIndex.sura}/saadi#ayat-${ayaIndex.aya}`
        })
    }

    if (menuState.includes("t")) { // Show recitation button only when it's a menu of text
        buttons.inline_keyboard[0].push({
            text: "🔊",
            callback_data: `{"recite":${ayaId},"r":"${reciter}"}`
        })
    }

    buttons.inline_keyboard[0].push({
        text: "▼",
        callback_data: `{"currAya":${ayaId},"r":"${reciter}"}`
    })
    return buttons
}




function successSend(ctx, ayaId, lang, trigger){
    var chatType = ctx.chat.type 
    var chatName = chatType == 'private' ? ctx.chat.first_name : ctx.chat.title
    log(`Successfully sent Aya ${ayaId} has been sent to chat ${ctx.chat.id}`)
    lastAyaTime(ctx.chat.id, 'success', chatName, chatType, lang, trigger)
}


function sendSorry(chatId, reason){
    return new Promise((resolve, reject) =>{
        var msg
        switch (reason) {
            case 'audio':
                msg =
`عذرا.. نواجه مشكلة في الملفات الصوتية ونأمل إصلاحها قريبا.
    
Sorry.. There's an issue in audio files and we hope it gets fixed soon.`
                break

            case 'text':
                msg =
`عذرا.. نواجه مشكلة في نصوص الآيات ونأمل إصلاحها قريبا.

Sorry.. There's an issue in Aya texts and we hope it gets fixed soon.`
                break
        
            default:
                msg =
`عذرا.. حدثت مشكلة غير معروفة.
    
Sorry.. An unknown issue happened.`
                break
        }


        bot.telegram.sendMessage(chatId, msg, {disable_notification: true})
        .then(ctx => {
            log(`Sorry message sent to ${chatId} due to ${reason}.`)
            resolve(ctx)
        })
        .catch(e => {
            log(`Failed to send sorry message to ${chatId}: `, e)
            reject(e)
        })
    })
}



function nextAya(ayaId){
    return ayaId == 6236 ? 1 : ayaId+1
}



// Sends an error message if unrecognized aya
function unrecognized(ctx, reason){
    var chatId = ctx.chat.id
    adminChecker(ctx)
    .then(isAdmin =>{
        if(isAdmin){
            var msg 

            switch (reason) {
                case 1:
                    msg =
`Не удалось распознать номер суры и аята.`
                    break;

                case 2:
                    msg =
`Извините, номер аята отсутствует в запрошенной суре.`
                    break;

                case 3:
                    msg =
`Не удалось распознать номер суры и аята.`
                    break;
            
                default:
                    msg =
`Неизвестная ошибка`
                    break;
            }

            bot.telegram.sendMessage(chatId, msg, {
                reply_markup: {
                    inline_keyboard:[
                        [{
                            text: "🎁",
                            callback_data: "surpriseAya"
                        },{
                            text: "🤔",
                            callback_data: "instructions"
                        }]
                    ]
                }
            })
                .then(log('Sent reason of unrecognized request to chat '+chatId+'.'))
                .catch(e=>log('Failed to send reason of unrecognized request to chat '+chatId+': ', e))
        } else {
            log(`Ignored message from non-admin user ${ctx.from.id} in chat ${ctx.chat.id}.`)
        }
    })
    .catch(e => log('Error while checking admin: ', e))
}





// Sends instructions message with buttons to get random aya or contact support
function instructions(chatId){
    var msg =
`Вы можете запросить конкретный аят, отправив номера аята и суры.
Пример: 22 55
Или только номер суры: 2`

    bot.telegram.sendMessage(chatId, msg)
        .then(log('Sent instructions message to chat '+chatId+'.'))
        .catch(e=>log('Failed to send instructions message to chat '+chatId+': ', e))
}






// Converting input arabic number into english one to easily find numbers in sent messages
function numArabicToEnglish(string) {
    return string.replace(/[\u0660-\u0669]/g, function (c) {
        return c.charCodeAt(0) - 0x0660
    })
}



const rasmifize                 = require('rasmify.js')
const normalizedSurasArNames    = ruQuran.map(s => rasmifize(s.name.substr(8)))
log("surasArNames count: " + normalizedSurasArNames.length)

const ArMagicRegex = new RegExp(`[${rasmifize('المهوسصق')}]`) // All Arabic names of Suras include at least one character of these

// Responds to text messages to send the requested Aya or error message if unrecognized
function handleText(ctx){
    var normalizedTxt   = rasmifize(numArabicToEnglish(ctx.message.text)),
        foundNums       = normalizedTxt.match(/\d+/g) || [],
        chatId          = ctx.chat.id,
        ayaId           = -2 // Positive for valid ayaId, 0 for valid sura but invalid aya, -1 for invalid sura, -2 or any other negative for initialization.
        foundArSuraNum  = 0 
    log('Message from chat ' + chatId+ ': ' + ctx.message.text)
    log('Normalized message from chat: ' + normalizedTxt)

    if(ArMagicRegex.test(normalizedTxt)) { 
        if(normalizedTxt.includes(rasmifize("الكرسي"))){
            ayaId = 262
        } else {
            for (let index = 0; index < normalizedSurasArNames.length; index++) {
                let regex = new RegExp(
                    `(^${normalizedSurasArNames[index]}$)|(^${
                    normalizedSurasArNames[index]}([-: 0-9]+)(.*))|((.*)([-: ]+)${
                    normalizedSurasArNames[index]}([-: 0-9]+)(.*))|((.*)([-: ]+)${normalizedSurasArNames[index]}$)`
                    )
                
                if(regex.test(normalizedTxt)){
                    foundArSuraNum = 1 + index
                    log("Found Arabic Sura number: " + foundArSuraNum)
                    break
                }
            }
            if (foundArSuraNum){
                ayaId = suraAya2ayaId({sura: foundArSuraNum, aya: foundNums.length ? foundNums[0] : 1})
            }
        }
    }
    if (foundNums.length && !foundArSuraNum){ // If no Sura Arabic names, look for numbers only
        ayaId = suraAya2ayaId({sura: foundNums[0], aya: foundNums.length >= 2 ? foundNums[1] : 1})
    } 

    if (ayaId > 0) {
        sendAya(chatId, ayaId, "", ctx.from.language_code, 'request', ctx.startPayload ? ctx.startPayload.includes("r") : false)
    } else if (ayaId < 0) {
        // if no Arabic sura name and first number is not valid sura number, send UNRECOGNIZED for reason 2
        unrecognized(ctx, 1)
    } else if (ayaId == 0){
        // if aya number is not valid aya in the requested Sura send UNRECOGNIZED for reason 2
        unrecognized(ctx, 2)
    }
}


function surpriseAya(ctx){
    sendAya(ctx.chat.id, "", "", ctx.from.language_code, 'surprise')
}


function adminChecker(ctx){
    return new Promise ((resolve, reject) => {
        if (ctx.chat.type == "private"){
            resolve(true)
        } else {
            bot.telegram.getChatMember(ctx.chat.id, ctx.from.id)
            .then(r => {
                if(r.status == "creator" || r.status == "administrator"){
                    resolve(true)
                } else {
                    resolve(false)
                }
            })
            .catch(e => {
                log('isAdmin check error: ', e)
                reject(e)
            })
        }
    })
}

// set the bot menu
bot.telegram.setMyCommands([
    {'command':'surpriseme', 'description': '🎁 Аят выбранный случайным образом'},
    {'command':'help', 'description': '🤔 Инструкции'},
    {'command':'support', 'description': '🤗 Поддержка'},
    {'command':'reciters', 'description': '🗣️ Выбрать чтеца'},
])


// Invoking start command
bot.start(ctx => {
    adminChecker(ctx)
    .then(isAdmin =>{
        if(isAdmin){
            if(ctx.startPayload.length) handleText(ctx)
            else start(ctx.chat.id)
        } else {
            log(`Ignored command from non-admin user ${ctx.from.id} in chat ${ctx.chat.id}.`)
        }
    })
    .catch(e =>{
        log('Error while checking admin: ', e)
    })
})

// Invoking help command
bot.help(ctx => {
    adminChecker(ctx)
    .then(isAdmin =>{
        if(isAdmin){
            instructions(ctx.chat.id)
        } else {
            log(`Ignored command from non-admin user ${ctx.from.id} in chat ${ctx.chat.id}.`)
        }
    })
    .catch(e => log('Error while checking admin: ', e))
})




// When a user presses "Surprise Me" in menu
bot.command('surpriseme', ctx => {
    adminChecker(ctx)
    .then(isAdmin =>{
        if(isAdmin){
            surpriseAya(ctx)
        } else {
            log(`Ignored command from non-admin user ${ctx.from.id} in chat ${ctx.chat.id}.`)
        }
    })
    .catch(e => log('Error while checking admin: ', e))
})


// When a user presses "Support" in menu
bot.command('support', ctx => {
    adminChecker(ctx)
    .then(isAdmin =>{
        if(isAdmin){
            var msg =
`👨‍💻`
            bot.telegram.sendMessage(ctx.chat.id, msg, {
                reply_markup: {
                    inline_keyboard:[
                        [{
                            text: "Связь 💬",
                            url: "https://t.me/Vasya95ast"
                        }],
                    ]
                }
            }).catch(er => log(`Error while sending support message: `, er))  
        } else {
            log(`Ignored command from non-admin user ${ctx.from.id} in chat ${ctx.chat.id}.`)
        }
    })
    .catch(e => log('Error while checking admin: ', e))
})



// When a user presses "set_fav_reciter" in menu
bot.command('reciters', ctx => {
    adminChecker(ctx)
    .then(isAdmin =>{
        if(isAdmin){
            var msg =
`Выберите чтеца...`
            bot.telegram.sendMessage(ctx.chat.id, msg, {
                reply_markup: {
                    inline_keyboard: recitersNavPage(1)
                }
            })
        } else {
            log(`Ignored command from non-admin user ${ctx.from.id} in chat ${ctx.chat.id}.`)
        }
    })
    .catch(e => log('Error while checking admin: ', e))
})

bot.command('channel', ctx => {
    adminChecker(ctx)
    .then(isAdmin =>{
        if(isAdmin){
            var msg = `https://t.me/DailyAyaGlobal`
            bot.telegram.sendMessage(ctx.chat.id, msg)
                .catch(er => log(`Error while sending channel message: `, er))
        } else {
            log(`Ignored command from non-admin user ${ctx.from.id} in chat ${ctx.chat.id}.`)
        }
    })
    .catch(e => log('Error while checking admin: ', e))
})

bot.command('khatma', ctx => {
    adminChecker(ctx)
    .then(isAdmin =>{
        if(isAdmin){
            var msg = `كم جزء قرأت؟ \nHow many ajzaa did you read?`
            var quran30btns = [[], [], [], [], [], []] // 6 rows
            let juzBtn = juz => {
                return {
                    text: juz,
                    callback_data: `{"groupkhatma": ${juz}}`
                }
            }
            quran30btns.forEach((row, i) =>{
                for (let juz = 1+(5*i); juz <= 5+(5*i); juz++) { // 5 buttons per row = 30 Juz
                    row.push(juzBtn(juz))
                }
            })

            bot.telegram.sendMessage(ctx.chat.id, msg, {reply_markup: {inline_keyboard: quran30btns}})
                .catch(er => log(`Error while sending channel message: `, er))
        } else {
            log(`Ignored command from non-admin user ${ctx.from.id} in chat ${ctx.chat.id}.`)
        }
    })
    .catch(e => log('Error while checking admin: ', e))
})

bot.action(/^{"groupkhatma/ , ctx =>{
    var callbackData = JSON.parse(ctx.update.callback_query.data)
    var juz = callbackData.groupkhatma
    let edit = khatmaUpdate({ctx: ctx, juz: juz})
    if (edit){
        ctx.replyWithHTML(
            `<a href="tg://user?id=${ctx.from.id}">${ctx.from.first_name}</a> ➔ ${juz} ${juz == 30 ? "🏆": "💪"}`,
            {disable_notification: true, reply_to_message_id: ctx.update.callback_query.message.message_id}
        ).then(() =>{
            ctx.editMessageText(edit, {parse_mode: 'HTML', reply_markup: ctx.update.callback_query.message.reply_markup})
                .then(() => ctx.answerCbQuery(
                    `تم التحديث ✔️\nنسأل الله أن يتقبل منا ومنكم 🤲\n\n`
                    +`✔️ Updated!\n🤲 May Allah accept from us and you.`,
                    {show_alert: true}
                ), e =>{
                    log(`Error while updating khatma: `, e)
                    ctx.answerCbQuery(
                        `تم الإرسال ✔️\nالملخص قد يكون ممتلئ ⚠️\nنسأل الله أن يتقبل منا ومنكم 🤲\n\n`
                        +`✔️ Sent!\n⚠️ Summary might be full.\n🤲 May Allah accept from us and you.`,
                        {show_alert: true}
                    )
                })
            
        }, e => {
            log(`Error while replying to khatma: `, e)
            ctx.answerCbQuery(
                `عذرا، يبدو أن لدينا مشكلة 😳\nسنحاول إصلاحها قريبا.\n\n`
                +`😳 Sorry, we might have an issue.\nWe will try to fix it soon.`,
                {show_alert: true}
            )
        })
    } else {
        ctx.answerCbQuery(
            `هذا الجزء هو اختيارك الحالي بالفعل ⚠️\n\n`
            +`⚠️ This Juz is already your current selection.`,
            {show_alert: true}
        ) 
    }
})

function khatmaUpdate({ctx: ctx, juz: juz}){
    let userId      = ctx.from.id,
        firstName   = ctx.from.first_name,
        text        = ctx.update.callback_query.message.text,
        entities    = ctx.update.callback_query.message.entities || []
    var textOffset  = 0

    entities.forEach(entity =>{ // adding HTML mentions in text
        let mention = `<a href="tg://user?id=${entity.user.id}">${entity.user.first_name}</a>`
        text = text.substr(0, textOffset+entity.offset) + mention + text.substr(textOffset+entity.offset+entity.length)
        textOffset += mention.length - entity.length
    })

    let update = `<a href="tg://user?id=${userId}">${firstName}</a> ➔ ${juz} ${juz == 30 ? "🏆": "💪"}`
    let textArray = text.split("\n\n")

    let userState = textArray.filter(item => item.indexOf(userId) > -1)[0]
    if (userState == update){
        return false // function returns here
    }


    let header = textArray.shift() // split header
    
    if (textArray.length == 0){
        textArray.push(update)
    } else {
        textArray = textArray.filter(item => item.indexOf(userId) === -1) // remove old update of that user, if any
        let index = textArray.findIndex(item => item.match(/(\d+)(?: ..$)/)[1] < juz) // find the first item with lower juz (".." for the emoji)
        if (index == -1){
            textArray.push(update)
        } else {
            textArray.splice(index, 0, update) // insert before the lower juz
        }
    }
    textArray.splice(0, 0, header) // add header
    return textArray.join("\n\n")
}

bot.command('commands', ctx => {
    adminChecker(ctx)
    .then(isAdmin =>{
        if(isAdmin){
            var msg = ``
            bot.telegram.getMyCommands().then(commands =>{
                commands.forEach(item =>{
                    msg += `/${item.command}\n${item.description}\n\n`
                })
                bot.telegram.sendMessage(ctx.chat.id, msg)
                    .catch(er => log(`Error while sending channel message: `, er))
            })
        } else {
            log(`Ignored command from non-admin user ${ctx.from.id} in chat ${ctx.chat.id}.`)
        }
    })
    .catch(e => log('Error while checking admin: ', e))
})


// bot.command(`restart`, ctx =>{
//     bot.telegram.sendMessage(ctx.chat.id, `Restarting...`)
//     .then(() =>{
//         log(`Restarting Command...`)
//         sigHandler(`restartCommand`)
//     })
// })

function recitersNavPage(page){
    var recitersPerPage = 5
    var totalPages = Math.ceil(recitersInlineButtons.length/recitersPerPage)
    var buttons = recitersInlineButtons.slice((page-1)*recitersPerPage, (page*recitersPerPage))
    var navRow = [{
        text: `🎲`,
        callback_data: `{"setReciter": "surprise"}`
    },{
        text: `＜`,
        callback_data:  page != 1 ? `{"recitersNavPage": ${page-1}}` : `{"recitersNavPage": ${totalPages}}`
    },{
        text: `${page}/${totalPages}`,
        callback_data:  "inactive"
    },{
        text: `＞`,
        callback_data:  page != totalPages ? `{"recitersNavPage": ${page+1}}` : `{"recitersNavPage": 1}`
    }]
    buttons.push(navRow)
    return buttons
}

var nonAdminsAlert =
`عذرا، هذه الخاصية في المجموعات والقنوات متاحة للمشرفين فقط.

Sorry, this feature in groups and channels is only available for admins.`

bot.action(/^{"recitersNavPage/ , ctx =>{
    adminChecker(ctx)
    .then(isAdmin =>{
        if(isAdmin){
            var callbackData = JSON.parse(ctx.update.callback_query.data)
            var requestedRecitersNavPage = callbackData.recitersNavPage
            bot.telegram.editMessageReplyMarkup(ctx.chat.id, ctx.update.callback_query.message.message_id, undefined, {
                inline_keyboard: recitersNavPage(requestedRecitersNavPage)
            }).catch(er => log(`Error while navigating reciters: `, er))
            ctx.answerCbQuery()
        } else {
            ctx.answerCbQuery(nonAdminsAlert, {show_alert: true})
        }
    })
    .catch(e => log('Error while checking admin: ', e))
})

bot.action(/^{"setReciter/ , ctx =>{
    adminChecker(ctx)
    .then(isAdmin =>{
        if(isAdmin){
            var callbackData = JSON.parse(ctx.update.callback_query.data)
            var requestedFavReciter = callbackData.setReciter
            
            setFavReciter(ctx.chat.id, requestedFavReciter)
            ctx.answerCbQuery()
        } else {
            ctx.answerCbQuery(nonAdminsAlert, {show_alert: true})
        }
    })
    .catch(e => log('Error while checking admin: ', e))
})



bot.action('instructions', ctx => {
    adminChecker(ctx)
    .then(isAdmin =>{
        if(isAdmin){
            instructions(ctx.chat.id)
            ctx.answerCbQuery()
        } else {
            ctx.answerCbQuery(nonAdminsAlert, {show_alert: true})
        }
    })
    .catch(e => log('Error while checking admin: ', e))
})


// When a user presses "Another Aya" inline keyboard button
bot.action('surpriseAya', ctx => {
    adminChecker(ctx)
    .then(isAdmin =>{
        if(isAdmin){
            surpriseAya(ctx)
            ctx.answerCbQuery()
        } else {
            ctx.answerCbQuery(nonAdminsAlert, {show_alert: true})
        }
    })
    .catch(e => log('Error while checking admin: ', e))
})



// When a user presses "Next Aya" inline keyboard button
bot.action(/^{"currAya/, ctx => {
    var callbackData= JSON.parse(ctx.update.callback_query.data)
    var currentAyaId = Math.floor(callbackData.currAya)

    adminChecker(ctx)
    .then(isAdmin =>{
        if(isAdmin){
            log(`Sending next Aya after Aya ${currentAyaId} with Reciter ${callbackData.r} for chat ${ctx.chat.id}`)
            sendAya(ctx.chat.id, nextAya(currentAyaId), callbackData.r, ctx.from.language_code, 'next')
            ctx.answerCbQuery()
        } else {
            var ayaIndex = ayaId2suraAya(nextAya(currentAyaId))
            ctx.answerCbQuery("", {url: `t.me/${bot.options.username}?start=${ayaIndex.sura}-${ayaIndex.aya}`})
        }
    })
    .catch(e => log('Error while checking admin: ', e))
})

bot.action(/^{"aMenu/ , ctx =>{
    adminChecker(ctx)
    .then(isAdmin =>{
        if(isAdmin){
            var callbackData = JSON.parse(ctx.update.callback_query.data),
                menu = callbackData.aMenu.includes("1") ? callbackData.aMenu.replace("1", "0") : callbackData.aMenu.replace("0", "1"), // Toggle menu state
                buttons = aMenuButtons(menu, callbackData.a, callbackData.r)
            bot.telegram.editMessageReplyMarkup(ctx.chat.id, ctx.update.callback_query.message.message_id, undefined, buttons)
                .catch(e => log(`Error while toggling menu: `, e))
            ctx.answerCbQuery()
        } else {
            ctx.answerCbQuery(nonAdminsAlert, {show_alert: true})
        }
    })
    .catch(e => log('Error while checking admin: ', e))
})



bot.action(/^{"recite/ , ctx =>{
    var callbackData = JSON.parse(ctx.update.callback_query.data)
    adminChecker(ctx)
    .then(isAdmin =>{
        if(isAdmin){
            log("Button reciter: " + callbackData.r)
            sendAyaRecitation(ctx, callbackData.recite, callbackData.r)
            ctx.answerCbQuery()
        } else {
            var ayaIndex = ayaId2suraAya(callbackData.recite)
            ctx.answerCbQuery("", {url: `t.me/${bot.options.username}?start=r${ayaIndex.sura}-${ayaIndex.aya}`})
        }
    })
    .catch(e => log('Error while checking admin: ', e))
})


bot.action(/^{"aReport/ , ctx =>{
    var callbackData = JSON.parse(ctx.update.callback_query.data)
    let ayaIndex = ayaId2suraAya(callbackData.aReport)
    log(`Aya report from user ${ctx.from.username ? '@'+ctx.from.username+', ID ': ''}${ctx.from.id}: `,
     `Aya: ${ayaIndex.sura}-${ayaIndex.aya}, Reciter: ${callbackData.r}`
    )
    ctx.answerCbQuery(
        `Ваш отчет об этом аяте был отправлен нашей команде.\nВозможно, мы свяжемся с вами в ближайшее время.\nДа вознаградит вас Аллах.`,
        {show_alert: true}
    )
})


bot.on('text', ctx => {
    adminChecker(ctx)
    .then(isAdmin =>{
        if(isAdmin){
            handleText(ctx)
        } else {
            log(`Ignored text from non-admin user ${ctx.from.id} in chat ${ctx.chat.id}.`)
        }
    })
    .catch(e => log('Error while checking admin: ', e))
})


// Responds to "some" non text messages to send UNRECOGNIZED for reason 3
// bot.on('sticker', ctx => unrecognized(ctx, 3))
// bot.on('photo', ctx => unrecognized(ctx, 3))
// bot.on('location', ctx => unrecognized(ctx, 3))
// bot.on('document', ctx => unrecognized(ctx, 3))
// bot.on('audio', ctx => unrecognized(ctx, 3))
// bot.on('voice', ctx => unrecognized(ctx, 3))
// bot.on('poll', ctx => unrecognized(ctx, 3))
// bot.on('contact', ctx => unrecognized(ctx, 3))




// to handle when blocked/unblocked by a user or when added/removed from groups
bot.on('my_chat_member', ctx => {
    switch (ctx.update.my_chat_member.new_chat_member.status) {
        case 'member': case 'administrator':
            if(ctx.chat.type != 'private') start(ctx.chat.id) // don't send to private chats as they already trigger /start
            break

        case 'kicked': case 'left':
            lastAyaTime(ctx.chat.id, 'blocked')
            break
    
        default:
            log('Unknown my_chat_member status: ', JSON.stringify(ctx))
            break
    }
})










//method to start get the script to pulling updates for telegram 
bot.launch()
.then(console.log('Bot launched.')) // using console.log() to log it regardless of debugging flag
.catch(e => log('Failed to launch bot: ', e))

bot.catch(e => log('bot error: ', e)) // to prevent the bot from restarting due to errors

function sigHandler(sig){
    log(`Exiting after ${+(process.uptime()/3600).toFixed(2)} hours and Used Memory ${Math.floor(process.memoryUsage().rss / (1024 * 1024))} MB due to: `, sig)
    .then(() => {
        console.log(`Stopping bot...`)
        bot.stop(sig)
        process.exit(0)
    })
}

// Enable graceful stop
process
    .on('SIGTERM', () => sigHandler('SIGTERM'))
    .on('SIGINT', () => sigHandler('SIGINT'))
    .on('uncaughtException', (err, origin) => {
        log(`Uncaught Exception of origin (${origin}): `, err)
        sigHandler('uncaughtException')
    })
    .on('unhandledRejection', (reason, promise) =>{
        log(`Unhandled Rejection due to reason (${reason}) for promise: `, promise)
        sigHandler('unhandledRejection')
    })
