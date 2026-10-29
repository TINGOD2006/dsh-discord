// Local decisions use the current event and small activity metadata, never an
// archive read or an extra model call.
const ACK = /^(?:好(?:的|喔|哦|啊)?|嗯+|喔+|哦+|了解|收到|謝謝(?:你)?|谢谢(?:你)?|感謝|感谢|ok(?:ay)?|thanks?|thank you|thx|哈哈+|笑死)[\s!！。.~～…]*$/iu;
const QUESTION = /[?？]|怎麼|怎么|如何|為什麼|为什么|為何|为何|什麼|什么|哪(?:個|个|些|裡|里|種|种)|能否|是否|可不可以|多少|幾(?:個|个|種|种|點|点|次|歲|岁)|(?:可以|會|会|能|是|有|要).{0,20}[嗎吗]|\b(?:what|why|how|when|where|who|which|can you|could you|would you|is it|are there|do you)\b/iu;
const REQUEST = /^(?:請|请|麻煩|麻烦|幫我|帮我|協助|协助|拜託|拜托|給我|给我|解釋|解释|說明|说明|分析|比較|比较|翻譯|翻译|整理|總結|总结|計算|计算|寫|写|列出|檢查|检查|修正|修復|修复|優化|优化|推薦|推荐|生成|設計|设计|畫|画|找|查|看看|我(?:想請|想请|有個問題|有个问题))|\b(?:please|help me|explain|summarize|translate|compare|calculate|write|generate|recommend|fix|review|show me|tell me)\b/iu;
const FOLLOWUP = /^(?:繼續|继续|再(?:短|長|长|詳|详|說|说|來|来|試|试|給|给)|換(?:個|个|一|種|种)|還有|还有|那(?:就|這|这|你|再)|就這|就这|不是|不對|不对|改成|加上|去掉|不用|保留|改用|同意|採用|采用|確定|确定|好[，,].+)|\b(?:continue|go on|shorter|longer|more detail|instead|try again|change it|add|remove|yes|no)\b/iu;

export function decideSmartReply(message, {
  botId, commandLike = false, expectedAnswer = false, continuation = false, activeFollowup = false, fromOwner = false,
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
  if (!/[\p{L}\p{N}]/u.test(text) || ACK.test(text)) return decision(false, 'acknowledgement');
  // The owner is who asked for this mode; staying silent on their plain chatter is
  // the behaviour they report as broken, so their messages always get an answer.
  if (fromOwner) return decision(true, 'owner');
  if (message.mentionedUserIds?.some(id => String(id) !== String(botId))) return decision(false, 'addressed-to-member');
  if (QUESTION.test(text) || REQUEST.test(text)) return decision(true, 'request');
  if (continuation) return decision(true, 'input-continuation');
  if (activeFollowup && FOLLOWUP.test(text)) return decision(true, 'followup');
  return decision(false, 'no-request');
}
