// Local decisions use the current event and small activity metadata, never an
// archive read or an extra model call.
const ACK = /^(?:好(?:的|喔|哦|啊)?|嗯+|喔+|哦+|了解|收到|謝謝(?:你)?|谢谢(?:你)?|感謝|感谢|ok(?:ay)?|thanks?|thank you|thx|哈哈+|笑死)[\s!！。.~～…]*$/iu;
// Traditional and Cantonese spellings are not optional here: this group writes
// 「甚麼」「點解」「咩」far more often than the simplified forms, and a question the
// policy cannot see is a question the bot silently ignores.
const QUESTION = /[?？]|怎麼|怎么|如何|為什麼|为什么|為何|为何|什麼|什么|甚麼|甚么|哪(?:個|个|些|裡|里|種|种)|能否|是否|可不可以|多少|幾(?:個|个|種|种|點|点|次|歲|岁)|(?:可以|會|会|能|是|有|要).{0,20}[嗎吗]|咩|乜|點解|点解|邊個|边个|邊度|边度|幾時|几时|係咪|系咪|係唔係|系唔系|有冇|有没|點樣|点样|\b(?:what|why|how|when|where|who|which|can you|could you|would you|is it|are there|do you)\b/iu;
const REQUEST = /^(?:請|请|麻煩|麻烦|幫我|帮我|協助|协助|拜託|拜托|給我|给我|解釋|解释|說明|说明|分析|比較|比较|翻譯|翻译|整理|總結|总结|計算|计算|寫|写|列出|檢查|检查|修正|修復|修复|優化|优化|推薦|推荐|生成|設計|设计|畫|画|找|查|看看|我(?:想請|想请|有個問題|有个问题))|\b(?:please|help me|explain|summarize|translate|compare|calculate|write|generate|recommend|fix|review|show me|tell me)\b/iu;
// Casual imperatives ("啟動一下原神", "装个原神") are how this group actually asks for
// things; they never match the formal verb list above, so they get their own
// anchored rule instead of widening REQUEST into a catch-all.
const CASUAL_REQUEST = /^(?:你)?(?:幫我|帮我|麻煩|麻烦|請|请)?(?:啟動|启动|裝|装|安裝|安装|執行|执行|試|试|教我|陪我|聊|講|讲|說|说|來一|来一|搞|弄|整|做個|做个|寫個|写个|開個|开个)/u;
const FOLLOWUP = /^(?:繼續|继续|再(?:短|長|长|詳|详|說|说|來|来|試|试|給|给)|換(?:個|个|一|種|种)|還有|还有|那(?:就|這|这|你|再)|就這|就这|不是|不對|不对|改成|加上|去掉|不用|保留|改用|同意|採用|采用|確定|确定|好[，,].+)|\b(?:continue|go on|shorter|longer|more detail|instead|try again|change it|add|remove|yes|no)\b/iu;

export function decideSmartReply(message, {
  botId, commandLike = false, expectedAnswer = false, continuation = false, activeFollowup = false, fromOwner = false, momentum = false,
} = {}) {
  const decision = (reply, reason) => ({ reply, reason });
  if (message.senderIsBot) return decision(false, 'bot-message');
  if (message.addressed === true || message.kind === 'direct') return decision(true, 'explicit');
  if (commandLike) return decision(true, 'command');
  if (expectedAnswer) return decision(true, 'expected-answer');
  const replyAuthor = message.replyTo?.authorId;
  if (replyAuthor) return decision(String(replyAuthor) === String(botId), String(replyAuthor) === String(botId) ? 'reply-to-bot' : 'reply-to-member');
  if (message.replyTo) return decision(false, 'reply-target-unknown');
  const text = String(message.content ?? '').trim();
  if (!/[\p{L}\p{N}]/u.test(text)) {
    // A bare "?"/"？？？" is someone asking to be answered; stickers and empty text
    // are not addressed to anyone, so those stay silent.
    return /[?？]/u.test(text) ? decision(true, 'question-punctuation') : decision(false, 'acknowledgement');
  }
  if (ACK.test(text)) return decision(false, 'acknowledgement');
  // The owner is who asked for this mode; staying silent on their plain chatter is
  // the behaviour they report as broken, so their messages always get an answer.
  if (fromOwner) return decision(true, 'owner');
  if (message.mentionedUserIds?.some(id => String(id) !== String(botId))) return decision(false, 'addressed-to-member');
  if (QUESTION.test(text) || REQUEST.test(text) || CASUAL_REQUEST.test(text)) return decision(true, 'request');
  if (continuation) return decision(true, 'input-continuation');
  if (activeFollowup && FOLLOWUP.test(text)) return decision(true, 'followup');
  // Mid-conversation: the bot answered this person moments ago, so a plain
  // sentence is a continuation of that exchange rather than room chatter.
  if (momentum) return decision(true, 'momentum');
  return decision(false, 'no-request');
}
