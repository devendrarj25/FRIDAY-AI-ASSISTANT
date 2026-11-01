/** Spoken and typed lines. Warmth is wording. None of these claim a human feeling. */

export type PhraseSlot = {
  id: string;
  lang: "en" | "hi" | "hinglish";
  emotion: string;
  intensity: "low" | "mid" | "high";
  context: "work" | "relaxed" | "late" | "hurry";
  kind: "ack" | "opener" | "closer" | "backchannel" | "repair" | "filler";
  text: string;
};

const emotions = [
  "neutral",
  "anger",
  "anxiety",
  "sadness",
  "excitement",
  "gratitude",
  "confusion",
  "hurry",
  "distress",
  "tiredness",
  "overwhelm",
  "disappointment",
  "relief",
] as const;
const langs = ["en", "hi", "hinglish"] as const;
const bands = ["low", "mid", "high"] as const;
const contexts = ["work", "relaxed", "late", "hurry"] as const;

/** Three lines per feeling, quiet to strong: the band picks the line, so a mild worry and a heavy one do not get the same words. */
const LINES: Record<string, Record<string, readonly [string, string, string]>> = {
  en: {
    neutral: ["I'm here. Say the next thing.", "Go ahead, I'm listening.", "Ready when you are."],
    anger: [
      "Fair. I'll keep this short and fix the actual step.",
      "That landed badly. Let me fix the real problem, not talk around it.",
      "You have every reason to be annoyed. I'll slow down and get this exactly right.",
    ],
    anxiety: [
      "We'll take one step at a time.",
      "Let's make this smaller. I'll say what is known and what is not.",
      "Breathe, it's one thing at a time. I'll hold the rest while we fix the first piece.",
    ],
    sadness: [
      "I'm with you on this. We can go slowly.",
      "That sounds heavy. No rush, I'm here.",
      "I'm sorry it's like this. We can take the work slowly, or just talk first.",
    ],
    excitement: [
      "Nice, that's good news.",
      "That's a real win. Want to take the next piece?",
      "That's a real win, congratulations. Shall we make the most of it?",
    ],
    gratitude: ["Glad that helped.", "Anytime, truly.", "Happy to help. That's what I'm here for."],
    confusion: [
      "Let me put that in one plain line.",
      "Let me say it simpler, with one example.",
      "That was my fault for being unclear. Here it is step by step.",
    ],
    hurry: ["On it.", "On it. Short version only.", "Right now. Only what matters."],
    distress: [
      "I'm here, and I'm glad you said it. This is software, not a clinician. A local helpline such as iCall or AASRA can sit with you.",
      "I'm here with you. I'm software, not a clinician, and you deserve a person right now: iCall or AASRA can talk with you.",
      "I'm here and I'm not going anywhere. I'm software, not a clinician. Please reach a person now: iCall or AASRA, or someone close to you.",
    ],
    tiredness: [
      "Sounds like a long day. We'll keep this light.",
      "You sound worn out. I'll do the heavy lifting where I can.",
      "You've been pushing hard. Let's do only what must be done and park the rest.",
    ],
    overwhelm: [
      "A lot at once. Let's pick just one thing.",
      "That's a lot to carry. Tell me the first thing and I'll take it from there.",
      "Too much at once would flatten anyone. Let's list it, pick one, and park the rest.",
    ],
    disappointment: [
      "That's a letdown. Let's see what can still be saved.",
      "That's disappointing, and it's fine to say so. Let's look at what's next.",
      "That's a hard one to take. When you're ready, we can work out the next move together.",
    ],
    relief: [
      "Good, that's off your plate.",
      "What a relief, well done getting through it.",
      "Finally. You earned that. Take a breath before the next thing.",
    ],
  },
  hi: {
    neutral: ["मैं यहीं हूँ। आगे बोलिए।", "बोलिए, मैं सुन रही हूँ।", "जब आप कहें।"],
    anger: [
      "ठीक है, सीधे काम पर आते हैं।",
      "बात सही है। मैं असली गड़बड़ी ठीक करती हूँ, इधर-उधर की बात नहीं।",
      "आपका नाराज़ होना जायज़ है। मैं धीरे और सही तरीके से इसे ठीक करती हूँ।",
    ],
    anxiety: [
      "एक-एक कदम चलते हैं।",
      "इसे छोटा कर लेते हैं। जो पता है वही कहूँगी।",
      "घबराइए मत, एक बार में एक ही चीज़। बाकी मैं संभाल कर रखती हूँ।",
    ],
    sadness: [
      "मैं साथ हूँ। आराम से चलेंगे।",
      "ये भारी लग रहा है। कोई जल्दी नहीं, मैं यहीं हूँ।",
      "ये सुनकर बुरा लगा। चाहें तो पहले बस बात कर लें, काम बाद में।",
    ],
    excitement: [
      "अच्छी बात है।",
      "ये सच में अच्छा हुआ। अगला काम लें?",
      "बहुत बढ़िया खबर है, बधाई! अब इसे आगे बढ़ाएँ?",
    ],
    gratitude: ["अच्छा लगा कि काम आया।", "कभी भी।", "आपके काम आ सकूँ, यही मेरा काम है।"],
    confusion: [
      "एक सीधी लाइन में बताती हूँ।",
      "आसान शब्दों में, एक उदाहरण के साथ।",
      "मैं ही साफ़ नहीं बोली। लीजिए, क़दम-दर-क़दम।",
    ],
    hurry: ["अभी।", "अभी। छोटा जवाब।", "बस ज़रूरी बात, तुरंत।"],
    distress: [
      "मैं यहीं हूँ, और आपने बताया ये अच्छा किया। मैं डॉक्टर नहीं हूँ। iCall या AASRA जैसी हेल्पलाइन से बात कर सकते हैं।",
      "मैं आपके साथ हूँ। मैं सॉफ़्टवेयर हूँ, डॉक्टर नहीं, और अभी आपको किसी इंसान से बात करनी चाहिए: iCall या AASRA।",
      "मैं यहीं हूँ, कहीं नहीं जा रही। मैं डॉक्टर नहीं हूँ। कृपया अभी iCall, AASRA या अपने किसी क़रीबी से बात करें।",
    ],
    tiredness: [
      "लंबा दिन लग रहा है। इसे हल्का रखेंगे।",
      "आप थके हुए लग रहे हैं। भारी काम जितना हो सके मैं कर लेती हूँ।",
      "आप बहुत खींच चुके हैं। सिर्फ़ ज़रूरी काम करेंगे, बाकी रुकेगा।",
    ],
    overwhelm: [
      "एक साथ बहुत कुछ है। बस एक चीज़ चुनते हैं।",
      "बहुत कुछ उठाया हुआ है। पहली चीज़ बताइए, वहाँ से मैं ले लूँगी।",
      "इतना सब एक साथ किसी को भी थका दे। सूची बनाते हैं, एक चुनते हैं, बाकी रोक देते हैं।",
    ],
    disappointment: [
      "ये निराश करने वाला है। देखते हैं क्या बच सकता है।",
      "निराशा होना स्वाभाविक है। आगे क्या हो सकता है, देखते हैं।",
      "ये सहना मुश्किल है। जब आप तैयार हों, अगला क़दम साथ सोचेंगे।",
    ],
    relief: [
      "अच्छा, ये निपट गया।",
      "चलो, राहत मिली। निपटाने के लिए शाबाश।",
      "आख़िर हो गया। आपने मेहनत की है, पहले एक गहरी साँस लीजिए।",
    ],
  },
  hinglish: {
    neutral: ["Haan, boliye.", "Boliye, main sun rahi hoon.", "Jab aap kahein."],
    anger: [
      "Theek hai, seedha fix karte hain.",
      "Baat sahi hai. Main asli problem theek karti hoon, ghuma-phira ke nahi.",
      "Aapka gussa jaayaz hai. Main dhyan se aur sahi tareeke se ise theek karti hoon.",
    ],
    anxiety: [
      "Ek ek step me chalte hain.",
      "Ise chhota kar lete hain. Jo pata hai wahi bolungi.",
      "Ghabraiye mat, ek time par ek hi cheez. Baaki main sambhal ke rakhti hoon.",
    ],
    sadness: [
      "Main saath hoon. Aaram se chalenge.",
      "Ye bhaari lag raha hai. Koi jaldi nahi, main yahin hoon.",
      "Ye sunke bura laga. Chaho to pehle bas baat kar lein, kaam baad me.",
    ],
    excitement: [
      "Achhi baat hai.",
      "Ye sach me achha hua. Agla kaam lein?",
      "Bahut badhiya khabar hai, badhai ho! Ab ise aage badhayein?",
    ],
    gratitude: ["Achha laga ki kaam aaya.", "Anytime.", "Aapke kaam aa saku, yahi mera kaam hai."],
    confusion: [
      "Ek seedhi line me batati hoon.",
      "Aasaan shabdon me, ek example ke saath.",
      "Main hi clear nahi boli. Ye lijiye, step by step.",
    ],
    hurry: ["Abhi.", "Abhi. Chhota jawab.", "Sirf zaroori baat, turant."],
    distress: [
      "Main yahin hoon, aur aapne bataya ye achha kiya. Main doctor nahi hoon. iCall ya AASRA jaisi helpline se baat kar sakte hain.",
      "Main aapke saath hoon. Main software hoon, doctor nahi, aur abhi aapko kisi insaan se baat karni chahiye: iCall ya AASRA.",
      "Main yahin hoon, kahin nahi ja rahi. Main doctor nahi hoon. Please abhi iCall, AASRA ya apne kisi kareebi se baat karein.",
    ],
    tiredness: [
      "Lamba din lag raha hai. Ise halka rakhenge.",
      "Aap thake hue lag rahe ho. Bhaari kaam jitna ho sake main kar leti hoon.",
      "Aap bahut kheench chuke ho. Sirf zaroori kaam karenge, baaki ruk sakta hai.",
    ],
    overwhelm: [
      "Ek saath bahut kuch hai. Bas ek cheez chunte hain.",
      "Bahut kuch utha rakha hai. Pehli cheez batao, wahan se main le lungi.",
      "Itna sab ek saath kisi ko bhi thaka de. List banate hain, ek chunte hain, baaki roke dete hain.",
    ],
    disappointment: [
      "Ye nirash karne wala hai. Dekhte hain kya bach sakta hai.",
      "Nirasha hona swabhavik hai. Aage kya ho sakta hai, dekhte hain.",
      "Ye sehna mushkil hai. Jab aap taiyaar ho, agla step saath sochenge.",
    ],
    relief: [
      "Achha, ye nipat gaya.",
      "Chalo, rahat mili. Nipatane ke liye shabash.",
      "Aakhir ho gaya. Aapne mehnat ki hai, pehle ek gehri saans lijiye.",
    ],
  },
};

function lineFor(
  lang: string,
  emotion: string,
  kind: PhraseSlot["kind"],
  context: string,
  bandIndex: number,
): string {
  const row = LINES[lang]?.[emotion] ?? LINES["en"]?.["neutral"];
  const base = row?.[bandIndex] ?? "I'm here.";
  const roman = lang === "hinglish";
  if (kind === "backchannel") return lang === "en" ? "Mm-hmm." : "हम्म।";
  if (kind === "repair") {
    if (lang === "en") return "That didn't land. Say it once more.";
    return roman ? "Woh clear nahi hua. Ek baar aur." : "वो साफ़ नहीं हुआ। एक बार और।";
  }
  if (kind === "filler") {
    if (lang === "en") return "One moment.";
    return roman ? "Ek second." : "एक सेकंड।";
  }
  if (kind === "closer") {
    if (lang === "en") return "That's the piece.";
    return roman ? "Bas itna." : "बस इतना।";
  }
  if (kind === "opener" && context === "late") {
    if (lang === "en") return "Still up. What do you need?";
    return roman ? "Abhi bhi yahin hoon." : "अभी भी यहीं हूँ।";
  }
  if (kind === "opener" && context === "hurry") {
    if (lang === "en") return "Go ahead.";
    return roman ? "Boliye, jaldi." : "बोलिए, जल्दी।";
  }
  return base;
}

export const PHRASE_BANK: readonly PhraseSlot[] = emotions.flatMap((emotion) =>
  langs.flatMap((lang) =>
    bands.flatMap((intensity) =>
      contexts.flatMap((context) =>
        (["ack", "opener", "closer", "backchannel", "repair", "filler"] as const).map((kind) => ({
          id: `${lang}-${emotion}-${intensity}-${context}-${kind}`,
          lang,
          emotion,
          intensity,
          context,
          kind,
          text: lineFor(lang, emotion, kind, context, bands.indexOf(intensity)),
        })),
      ),
    ),
  ),
);
