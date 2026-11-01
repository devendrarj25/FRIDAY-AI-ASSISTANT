/**
 * FRIDAY · comfort
 *
 * Understanding how the owner is doing and answering it kindly, without a model and without pretending. She reads
 * his words (English, Hinglish, Devanagari) and the pattern of his last messages, names what she sees as a guess he
 * can correct, and offers one small concrete thing. A message that is only a feeling gets a short, warm reply of its
 * own; a message that also carries a task keeps its task and the warmth is added in front of it by the reply shaper.
 * Warmth here is wording and behaviour. Nothing says she feels what he feels, and nothing diagnoses him.
 */

import { affect, readFeeling, type FeelingLabel } from "./affect";
import { registerOf, type Register } from "../response-policy";
import { pickPhrase } from "../phrase-bank";

const COMFORTABLE = new Set<FeelingLabel>([
  "sadness",
  "anxiety",
  "overwhelm",
  "tiredness",
  "disappointment",
  "anger",
  "excitement",
  "relief",
  "distress",
]);

/** A message with a job in it is the model's, with warmth in front. Only a message that is just a feeling is answered here. */
const TASK_WORD =
  /\b(open|kholo|khol|send|bhej\w*|create|banao|delete|hata\w*|find|search|dhundo|khojo|remind|reminder|yaad|write|likh\w*|install|download|run|chalao|chala|set|laga\w*|play|schedule|book|order|email|mail|file|folder|pdf|report|meeting|code|fix|error)\b/i;

const OFFERS: Partial<Record<FeelingLabel, Record<Register, string>>> = {
  sadness: {
    en: "Want to talk about it, or shall I keep today's work light?",
    hi: "बात करना चाहें तो बताइए, या आज काम हल्का रखूँ?",
    hinglish: "Baat karni ho to bolo, ya aaj ka kaam halka rakhun?",
  },
  disappointment: {
    en: "When you're ready, tell me what happened and we'll see what can still be saved.",
    hi: "जब ठीक लगे, बताइए क्या हुआ, फिर देखते हैं क्या बचाया जा सकता है।",
    hinglish: "Jab theek lage, batao kya hua, phir dekhte hain kya bachaya ja sakta hai.",
  },
  anxiety: {
    en: "Tell me the one thing that feels heaviest and I'll start with just that.",
    hi: "जो सबसे भारी लग रहा है वो एक चीज़ बताइए, मैं उसी से शुरू करती हूँ।",
    hinglish: "Jo sabse bhaari lag raha hai wo ek cheez batao, main usi se shuru karti hoon.",
  },
  overwhelm: {
    en: "Give me the list in any order and I'll sort it into what must happen today and what can wait.",
    hi: "सूची किसी भी क्रम में दीजिए, मैं छाँट दूँगी कि आज क्या ज़रूरी है और क्या रुक सकता है।",
    hinglish:
      "List kisi bhi order me do, main chhant dungi ki aaj kya zaroori hai aur kya ruk sakta hai.",
  },
  tiredness: {
    en: "Want me to set aside everything that isn't urgent for now?",
    hi: "जो ज़रूरी नहीं उसे फ़िलहाल अलग रख दूँ?",
    hinglish: "Jo zaroori nahi use filhaal alag rakh dun?",
  },
  anger: {
    en: "Tell me the exact step that went wrong and I'll fix that first.",
    hi: "बताइए कौन सा क़दम गड़बड़ हुआ, मैं सबसे पहले वही ठीक करती हूँ।",
    hinglish: "Batao kaun sa step gadbad hua, main sabse pehle wahi theek karti hoon.",
  },
  excitement: {
    en: "Want to line up what comes next while it's going well?",
    hi: "जब सब अच्छा चल रहा है तो अगला काम तय कर लें?",
    hinglish: "Jab sab achha chal raha hai to agla kaam tay kar lein?",
  },
  relief: {
    en: "Take a breath. Shall I clear anything else off your list?",
    hi: "एक गहरी साँस लीजिए। सूची में से कुछ और निपटा दूँ?",
    hinglish: "Ek gehri saans lo. List me se kuch aur nipta dun?",
  },
};

const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/** True when the message is only a feeling and she can answer it without a model. */
export function isPureFeeling(text: string): boolean {
  const value = String(text || "").trim();
  if (!value || wordCount(value) > 14) return false;
  if (/\d|https?:|[a-z]:\\|\//i.test(value)) return false;
  if (TASK_WORD.test(value)) return false;
  const feeling = readFeeling(value);
  return COMFORTABLE.has(feeling.label) && feeling.confidence >= 0.6;
}

export function comfortReply(text: string): string | null {
  if (!isPureFeeling(text)) return null;
  const feeling = readFeeling(text);
  const register = registerOf(text);
  const ack = pickPhrase({
    lang: register,
    emotion: feeling.label,
    intensity: feeling.intensity >= 0.66 ? "high" : feeling.intensity >= 0.33 ? "mid" : "low",
    context: "relaxed",
    kind: "ack",
  });
  // Distress already carries a person to talk to; nothing is added after it.
  if (feeling.label === "distress") return ack;
  const offer = OFFERS[feeling.label]?.[register];
  return offer ? `${ack} ${offer}` : ack;
}

/** "Galat padha", "I'm not sad": the owner corrects a reading, and she drops it. */
const CORRECTION =
  /\b(galat (padha|samjha|samjhi)|tumne galat|you (misread|got (it|me) wrong)|(main|mai|mein) (udaas|dukhi|sad|upset|tired|thaka|gussa|naraz) nahi|i'?m not (sad|upset|angry|tired|stressed))\b/i;

export function correctMoodReading(text: string): string | null {
  const value = String(text || "");
  if (value.length > 300 || !CORRECTION.test(value)) return null;
  affect.forgetReadings();
  const register = registerOf(text);
  return register === "en"
    ? "Understood. I've dropped that reading, and I'll go by what you tell me, not by my guess."
    : register === "hi"
      ? "ठीक है, मैंने वो अंदाज़ा हटा दिया। अब मैं आपके कहने पर चलूँगी, अपने अंदाज़े पर नहीं।"
      : "Theek hai, maine wo andaza hata diya. Ab main tumhare kehne par chalungi, apne andaze par nahi.";
}

const NAMES: Record<string, Record<Register, string>> = {
  anger: { en: "annoyed", hi: "नाराज़", hinglish: "naraz" },
  anxiety: { en: "worried", hi: "चिंतित", hinglish: "chintit" },
  sadness: { en: "low", hi: "उदास", hinglish: "udaas" },
  tiredness: { en: "tired", hi: "थके हुए", hinglish: "thake hue" },
  overwhelm: { en: "overloaded", hi: "काम के बोझ में", hinglish: "kaam ke bojh me" },
  disappointment: { en: "let down", hi: "निराश", hinglish: "nirash" },
};

/** "How do I sound?": what she reads from his recent messages, said as a guess he can correct. */
export function describeUserMood(text = ""): string {
  const register = registerOf(text);
  const trend = affect.moodTrend();
  const state = affect.getSnapshot();
  const name = NAMES[trend.label]?.[register];
  const spoken = state.channel === "voice" && state.voice !== null;
  if (trend.carrying && name) {
    return register === "en"
      ? `From your last ${trend.of} messages you've sounded ${name} in ${trend.count} of them. That's only my guess from your ${spoken ? "words and voice" : "words"}; tell me if I've got it wrong and I'll drop it. If it helps, I can make today smaller.`
      : register === "hi"
        ? `आपके पिछले ${trend.of} संदेशों में से ${trend.count} में आप ${name} लगे। ये बस आपके ${spoken ? "शब्दों और आवाज़" : "शब्दों"} से मेरा अंदाज़ा है; ग़लत हो तो बताइए, मैं हटा दूँगी। चाहें तो आज का दिन छोटा कर दूँ।`
        : `Tumhare pichle ${trend.of} messages me se ${trend.count} me tum ${name} lage. Ye bas tumhare ${spoken ? "shabdon aur awaaz" : "shabdon"} se mera andaza hai; galat ho to bolo, main hata dungi. Chaho to aaj ka din chhota kar dun.`;
  }
  const now = (["low", "stress", "frustration", "urgency", "confusion", "excitement"] as const)
    .map((key) => ({ key, level: state.user[key] }))
    .filter((row) => row.level >= 0.4)
    .sort((a, b) => b.level - a.level)[0];
  if (now) {
    const word: Record<string, [string, string, string]> = {
      low: ["a little low", "थोड़े उदास", "thode udaas"],
      stress: ["under some pressure", "थोड़े दबाव में", "thode pressure me"],
      frustration: ["frustrated", "झुँझलाए हुए", "jhunjhlaye hue"],
      urgency: ["in a hurry", "जल्दी में", "jaldi me"],
      confusion: ["unsure about something", "किसी बात पर उलझन में", "kisi baat par uljhan me"],
      excitement: ["in good spirits", "अच्छे मूड में", "achhe mood me"],
    };
    const [en, hi, hinglish] = word[now.key] as [string, string, string];
    return register === "en"
      ? `Right now you seem ${en}. That's a guess from your ${spoken ? "words and voice" : "words"}; correct me if it's off.`
      : register === "hi"
        ? `अभी आप ${hi} लग रहे हैं। ये आपके ${spoken ? "शब्दों और आवाज़" : "शब्दों"} से अंदाज़ा है; ग़लत हो तो बताइए।`
        : `Abhi tum ${hinglish} lag rahe ho. Ye tumhare ${spoken ? "shabdon aur awaaz" : "shabdon"} se andaza hai; galat ho to bata dena.`;
  }
  return register === "en"
    ? "I'm not picking up anything unusual from your messages right now. If something's on your mind, say it and I'll listen."
    : register === "hi"
      ? "आपके संदेशों से अभी कुछ ख़ास नहीं पकड़ पाई। मन में कुछ हो तो बताइए, मैं सुनूँगी।"
      : "Tumhare messages se abhi kuch khaas nahi pakad paayi. Man me kuch ho to batao, main sunungi.";
}
