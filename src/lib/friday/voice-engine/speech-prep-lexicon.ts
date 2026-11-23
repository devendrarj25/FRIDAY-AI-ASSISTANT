/**
 * FRIDAY · Speech Prep word tables (FRIDAY's own curated data, written from knowledge, not copied from a package).
 *
 * Format: whitespace separated pairs, `latin-key devanagari`. Keys are lower-case ASCII letters only. Values are
 * Devanagari only. Parsed once by `speech-prep.ts`. Not heard through a voice here: the owner corrects an entry
 * through the pronunciation dictionary (Settings, Voice).
 *
 * Research (2026-11-22): the English to Devanagari lexicon inside the `indic-tiny-tts-hindi` package (its code is
 * MIT, its weights CC-BY-4.0) was read about; the licence file does not cover the lexicon data or its cmudict and
 * IndicXlit sources, so nothing was adapted from it. REJECT as a data source, own table built instead.
 */

const TECH = `
computer कंप्यूटर laptop लैपटॉप desktop डेस्कटॉप phone फ़ोन mobile मोबाइल smartphone स्मार्टफ़ोन tablet टैबलेट
screen स्क्रीन monitor मॉनिटर keyboard कीबोर्ड mouse माउस printer प्रिंटर scanner स्कैनर camera कैमरा microphone
माइक्रोफ़ोन mic माइक speaker स्पीकर headphone हेडफ़ोन headphones हेडफ़ोन्स earphones ईयरफ़ोन्स bluetooth ब्लूटूथ
wifi वाईफ़ाई internet इंटरनेट network नेटवर्क router राउटर modem मॉडेम server सर्वर cloud क्लाउड data डेटा
database डेटाबेस file फ़ाइल folder फ़ोल्डर drive ड्राइव disk डिस्क storage स्टोरेज memory मेमोरी ram रैम cpu
सीपीयू gpu जीपीयू ssd एसएसडी usb यूएसबी pdf पीडीएफ api एपीआई url यूआरएल ai एआई ok ओके okay ओके software
सॉफ़्टवेयर hardware हार्डवेयर app ऐप application एप्लिकेशन program प्रोग्राम update अपडेट upgrade अपग्रेड
install इंस्टॉल uninstall अनइंस्टॉल installer इंस्टॉलर download डाउनलोड upload अपलोड save सेव delete डिलीट
remove रिमूव copy कॉपी paste पेस्ट cut कट undo अनडू redo रीडू open ओपन close क्लोज़ start स्टार्ट stop स्टॉप
pause पॉज़ resume रिज़्यूम play प्ले restart रीस्टार्ट reboot रीबूट shutdown शटडाउन sleep स्लीप lock लॉक unlock
अनलॉक login लॉगिन logout लॉगआउट signin साइनइन signup साइनअप password पासवर्ड username यूज़रनेम user यूज़र
account अकाउंट profile प्रोफ़ाइल settings सेटिंग्स setting सेटिंग setup सेटअप option ऑप्शन menu मेन्यू button
बटन click क्लिक tap टैप swipe स्वाइप scroll स्क्रोल drag ड्रैग drop ड्रॉप select सेलेक्ट search सर्च find फ़ाइंड
filter फ़िल्टर sort सॉर्ट refresh रिफ़्रेश reload रीलोड sync सिंक backup बैकअप restore रिस्टोर reset रीसेट clear
क्लियर cache कैश cookies कुकीज़ history हिस्ट्री bookmark बुकमार्क tab टैब window विंडो windows विंडोज़ browser
ब्राउज़र chrome क्रोम firefox फ़ायरफ़ॉक्स edge एज safari सफ़ारी google गूगल gmail जीमेल youtube यूट्यूब whatsapp
व्हाट्सऐप telegram टेलीग्राम instagram इंस्टाग्राम facebook फ़ेसबुक twitter ट्विटर linkedin लिंक्डइन snapchat
स्नैपचैट spotify स्पॉटिफ़ाई netflix नेटफ़्लिक्स amazon अमेज़न flipkart फ़्लिपकार्ट paytm पेटीएम phonepe फ़ोनपे
gpay जीपे zoom ज़ूम teams टीम्स meet मीट skype स्काइप slack स्लैक discord डिस्कॉर्ड github गिटहब git गिट python
पाइथन java जावा javascript जावास्क्रिप्ट html एचटीएमएल css सीएसएस code कोड coding कोडिंग bug बग error एरर
warning वॉर्निंग crash क्रैश fix फ़िक्स issue इश्यू problem प्रॉब्लम solution सॉल्यूशन excel एक्सेल word वर्ड
powerpoint पावरपॉइंट outlook आउटलुक notepad नोटपैड calculator कैलकुलेटर calendar कैलेंडर notes नोट्स note नोट
reminder रिमाइंडर alarm अलार्म timer टाइमर stopwatch स्टॉपवॉच clock क्लॉक notification नोटिफ़िकेशन alert अलर्ट
message मैसेज text टेक्स्ट chat चैट call कॉल video वीडियो audio ऑडियो voice वॉइस photo फ़ोटो picture पिक्चर
image इमेज screenshot स्क्रीनशॉट gallery गैलरी music म्यूज़िक song सॉन्ग playlist प्लेलिस्ट radio रेडियो podcast
पॉडकास्ट movie मूवी film फ़िल्म series सीरीज़ episode एपिसोड email ईमेल mail मेल inbox इनबॉक्स spam स्पैम draft
ड्राफ़्ट attachment अटैचमेंट link लिंक website वेबसाइट web वेब site साइट page पेज blog ब्लॉग post पोस्ट comment
कमेंट like लाइक share शेयर follow फ़ॉलो subscribe सबस्क्राइब channel चैनल story स्टोरी reel रील live लाइव stream
स्ट्रीम online ऑनलाइन offline ऑफ़लाइन wireless वायरलेस charger चार्जर charging चार्जिंग battery बैटरी power पावर
plug प्लग cable केबल port पोर्ट device डिवाइस gadget गैजेट sensor सेंसर display डिस्प्ले touch टच pixel पिक्सल
resolution रेज़ोल्यूशन brightness ब्राइटनेस volume वॉल्यूम mute म्यूट unmute अनम्यूट silent साइलेंट vibrate
वाइब्रेट ringtone रिंगटोन airplane एयरप्लेन mode मोड hotspot हॉटस्पॉट sim सिम signal सिग्नल version वर्ज़न beta
बीटा release रिलीज़ build बिल्ड test टेस्ट debug डीबग deploy डिप्लॉय script स्क्रिप्ट terminal टर्मिनल command
कमांड shell शेल path पाथ directory डायरेक्टरी config कॉन्फ़िग log लॉग kernel कर्नेल process प्रोसेस task टास्क
service सर्विस driver ड्राइवर virus वायरस antivirus एंटीवायरस firewall फ़ायरवॉल security सिक्योरिटी privacy
प्राइवेसी permission परमिशन access एक्सेस admin एडमिन administrator एडमिनिस्ट्रेटर authentication ऑथेंटिकेशन otp
ओटीपी pin पिन token टोकन key की encryption एन्क्रिप्शन hacker हैकर hack हैक phishing फ़िशिंग scam स्कैम fraud
फ़्रॉड robot रोबोट bot बॉट assistant असिस्टेंट friday फ़्राइडे jarvis जार्विस alexa एलेक्सा siri सिरी chatgpt
चैटजीपीटी gemini जेमिनी claude क्लॉड openai ओपनएआई microsoft माइक्रोसॉफ़्ट apple ऐपल android एंड्रॉइड iphone
आईफ़ोन ipad आईपैड mac मैक linux लिनक्स ubuntu उबंटू samsung सैमसंग xiaomi शाओमी oneplus वनप्लस realme रियलमी
vivo विवो oppo ओप्पो nokia नोकिया sony सोनी dell डेल hp एचपी lenovo लेनोवो asus आसुस acer एसर intel इंटेल amd
एएमडी nvidia एनवीडिया
`;

const TIME_AND_PLACE = `
monday मंडे tuesday ट्यूज़डे wednesday वेडनसडे thursday थर्सडे saturday सैटरडे sunday संडे january जनवरी
february फ़रवरी march मार्च april अप्रैल may मई june जून july जुलाई august अगस्त september सितंबर october
अक्टूबर november नवंबर december दिसंबर today टुडे tomorrow टुमॉरो yesterday येस्टरडे tonight टुनाइट morning
मॉर्निंग afternoon आफ़्टरनून evening ईवनिंग night नाइट midnight मिडनाइट noon नून am एएम pm पीएम second सेकंड
seconds सेकंड्स minute मिनट minutes मिनट्स hour ऑवर hours ऑवर्स day डे days डेज़ week वीक weeks वीक्स weekend
वीकेंड weekday वीकडे month मंथ months मंथ्स year ईयर years ईयर्स date डेट time टाइम schedule शेड्यूल appointment
अपॉइंटमेंट meeting मीटिंग meetings मीटिंग्स deadline डेडलाइन event इवेंट birthday बर्थडे anniversary एनिवर्सरी
holiday हॉलिडे vacation वेकेशन trip ट्रिप travel ट्रैवल flight फ़्लाइट ticket टिकट booking बुकिंग hotel होटल
room रूम airport एयरपोर्ट station स्टेशन train ट्रेन bus बस taxi टैक्सी cab कैब auto ऑटो metro मेट्रो bike बाइक
car कार road रोड traffic ट्रैफ़िक petrol पेट्रोल diesel डीज़ल parking पार्किंग route रूट map मैप maps मैप्स
location लोकेशन address एड्रेस navigation नेविगेशन direction डायरेक्शन distance डिस्टेंस kilometer किलोमीटर km
किलोमीटर meter मीटर mile माइल gps जीपीएस delhi दिल्ली mumbai मुंबई bangalore बैंगलोर bengaluru बेंगलुरु chennai
चेन्नई kolkata कोलकाता hyderabad हैदराबाद pune पुणे jaipur जयपुर lucknow लखनऊ india इंडिया indian इंडियन hindi
हिंदी english इंग्लिश hinglish हिंग्लिश office ऑफ़िस home होम house हाउस school स्कूल college कॉलेज university
यूनिवर्सिटी class क्लास classes क्लासेस exam एग्ज़ाम result रिज़ल्ट marks मार्क्स study स्टडी homework होमवर्क
assignment असाइनमेंट project प्रोजेक्ट presentation प्रेज़ेंटेशन report रिपोर्ट document डॉक्यूमेंट form फ़ॉर्म
interview इंटरव्यू job जॉब company कंपनी business बिज़नेस client क्लाइंट customer कस्टमर manager मैनेजर boss बॉस
team टीम staff स्टाफ़ employee एम्प्लॉई salary सैलरी leave लीव
`;

const MONEY_AND_LIFE = `
bank बैंक balance बैलेंस payment पेमेंट pay पे paid पेड transfer ट्रांसफ़र transaction ट्रांज़ैक्शन upi यूपीआई
card कार्ड credit क्रेडिट debit डेबिट loan लोन emi ईएमआई interest इंटरेस्ट tax टैक्स gst जीएसटी invoice इनवॉइस
bill बिल receipt रसीद refund रिफ़ंड offer ऑफ़र discount डिस्काउंट sale सेल coupon कूपन cashback कैशबैक order
ऑर्डर delivery डिलीवरी cart कार्ट shopping शॉपिंग shop शॉप store स्टोर market मार्केट mall मॉल price प्राइस cost
कॉस्ट budget बजट expense एक्सपेंस income इनकम profit प्रॉफ़िट loss लॉस investment इन्वेस्टमेंट stock स्टॉक fund
फ़ंड insurance इंश्योरेंस policy पॉलिसी rupees रुपीज़ rupee रुपी dollar डॉलर dollars डॉलर्स percent परसेंट
percentage परसेंटेज number नंबर numbers नंबर्स total टोटल amount अमाउंट average एवरेज doctor डॉक्टर hospital
हॉस्पिटल medicine मेडिसिन clinic क्लिनिक health हेल्थ fitness फ़िटनेस gym जिम yoga योगा diet डाइट exercise
एक्सरसाइज़ walk वॉक run रन running रनिंग stress स्ट्रेस fever फ़ीवर cold कोल्ड cough कफ़ headache हेडेक pain पेन
checkup चेकअप nurse नर्स dentist डेंटिस्ट food फ़ूड lunch लंच dinner डिनर breakfast ब्रेकफ़ास्ट snack स्नैक
coffee कॉफ़ी tea टी juice जूस water वॉटर pizza पिज़्ज़ा burger बर्गर sandwich सैंडविच biscuit बिस्किट cake केक
chocolate चॉकलेट ice आइस cream क्रीम restaurant रेस्टोरेंट cafe कैफ़े sir सर madam मैडम mister मिस्टर mr मिस्टर
mrs मिसेज़ miss मिस dr डॉक्टर hello हैलो hi हाय hey हे bye बाय goodbye गुडबाय thanks थैंक्स thank थैंक thankyou
थैंक्यू sorry सॉरी please प्लीज़ welcome वेलकम congratulations कॉन्ग्रैचुलेशंस congrats कॉन्ग्रैट्स wow वाह yes
यस no नो friend फ़्रेंड friends फ़्रेंड्स family फ़ैमिली mummy मम्मी daddy डैडी brother ब्रदर sister सिस्टर
uncle अंकल aunty आंटी boy बॉय girl गर्ल baby बेबी kid किड kids किड्स guest गेस्ट party पार्टी wedding वेडिंग
function फ़ंक्शन gift गिफ़्ट surprise सरप्राइज़ cricket क्रिकेट match मैच football फ़ुटबॉल game गेम games गेम्स
player प्लेयर score स्कोर win विन lose लूज़ news न्यूज़ weather वेदर temperature टेम्परेचर rain रेन sunny सनी
hot हॉट cool कूल
`;

const GENERAL = `
the द and एंड of ऑफ़ to टू for फ़ॉर in इन on ऑन off ऑफ़ with विद at ऐट by बाय from फ़्रॉम is इज़ are आर good गुड
bad बैड best बेस्ट better बेहतर nice नाइस great ग्रेट super सुपर perfect परफ़ेक्ट fine फ़ाइन easy ईज़ी hard
हार्ड fast फ़ास्ट slow स्लो quick क्विक simple सिंपल normal नॉर्मल special स्पेशल important इंपोर्टेंट urgent
अर्जेंट free फ़्री new न्यू old ओल्ड latest लेटेस्ट next नेक्स्ट last लास्ट first फ़र्स्ट final फ़ाइनल full फ़ुल
half हाफ़ double डबल single सिंगल main मेन major मेजर minor माइनर extra एक्स्ट्रा ready रेडी busy बिज़ी
available अवेलेबल active एक्टिव inactive इनएक्टिव enabled एनेबल्ड disabled डिसेबल्ड true ट्रू false फ़ॉल्स done
डन complete कंप्लीट completed कंप्लीटेड pending पेंडिंग success सक्सेस failed फ़ेल्ड fail फ़ेल cancel कैंसल
confirm कन्फ़र्म confirmed कन्फ़र्म्ड approve अप्रूव approved अप्रूव्ड reject रिजेक्ट allow अलाउ allowed अलाउड
deny डिनाई send सेंड sent सेंट receive रिसीव received रिसीव्ड reply रिप्लाई forward फ़ॉरवर्ड add ऐड added ऐडेड
create क्रिएट created क्रिएटेड edit एडिट change चेंज changed चेंज्ड set सेट get गेट go गो back बैक previous
प्रीवियस skip स्किप continue कंटिन्यू repeat रिपीट again अगेन later लेटर soon सून now नाउ wait वेट hold होल्ड
check चेक checking चेकिंग verify वेरिफ़ाई scan स्कैन read रीड write राइट type टाइप print प्रिंट show शो hide
हाइड view व्यू preview प्रीव्यू listen लिसन speak स्पीक talk टॉक say से tell टेल ask आस्क answer आंसर question
क्वेश्चन help हेल्प support सपोर्ट guide गाइड tip टिप trick ट्रिक idea आइडिया plan प्लान planning प्लानिंग goal
गोल target टारगेट priority प्रायोरिटी list लिस्ट todo टूडू tasks टास्क्स step स्टेप steps स्टेप्स level लेवल
rank रैंक rating रेटिंग review रिव्यू feedback फ़ीडबैक suggestion सजेशन choice चॉइस manual मैनुअल automatic
ऑटोमैटिक custom कस्टम default डिफ़ॉल्ट standard स्टैंडर्ड basic बेसिक advanced एडवांस्ड pro प्रो premium
प्रीमियम plus प्लस lite लाइट max मैक्स min मिन limit लिमिट unlimited अनलिमिटेड quality क्वालिटी size साइज़ small
स्मॉल medium मीडियम large लार्ज big बिग long लॉन्ग short शॉर्ट high हाई low लो top टॉप bottom बॉटम left लेफ़्ट
right राइट up अप down डाउन center सेंटर side साइड front फ़्रंट end एंड begin बिगिन owner ओनर member मेंबर group
ग्रुप contact कॉन्टैक्ट contacts कॉन्टैक्ट्स name नेम id आईडी one वन two टू three थ्री four फ़ोर five फ़ाइव six
सिक्स seven सेवन eight एट nine नाइन ten टेन zero ज़ीरो eleven इलेवन twelve ट्वेल्व twenty ट्वेंटी thirty थर्टी
forty फ़ोर्टी fifty फ़िफ़्टी hundred हंड्रेड thousand थाउज़ंड million मिलियन billion बिलियन lakh लाख crore करोड़
lakhs लाख crores करोड़ a ए b बी c सी d डी e ई f एफ़ g जी h एच i आई j जे k के l एल m एम n एन o ओ p पी q क्यू r आर
s एस t टी u यू v वी w डब्ल्यू x एक्स y वाई z ज़ेड
`;

const WORK_AND_WORLD = `
wallpaper वॉलपेपर theme थीम dark डार्क font फ़ॉन्ट icon आइकन shortcut शॉर्टकट widget विजेट toolbar टूलबार
sidebar साइडबार dropdown ड्रॉपडाउन checkbox चेकबॉक्स slider स्लाइडर toggle टॉगल popup पॉपअप banner बैनर template
टेम्पलेट layout लेआउट design डिज़ाइन designer डिज़ाइनर developer डेवलपर engineer इंजीनियर programmer प्रोग्रामर
frontend फ़्रंटएंड backend बैकएंड query क्वेरी table टेबल column कॉलम row रो sheet शीट spreadsheet स्प्रेडशीट
chart चार्ट graph ग्राफ़ summary समरी detail डिटेल details डिटेल्स overview ओवरव्यू analysis एनालिसिस analytics
एनालिटिक्स dashboard डैशबोर्ड metric मेट्रिक stats स्टैट्स statistics स्टैटिस्टिक्स trend ट्रेंड forecast
फ़ोरकास्ट prediction प्रिडिक्शन model मॉडल models मॉडल्स training ट्रेनिंग dataset डेटासेट prompt प्रॉम्प्ट
response रिस्पॉन्स request रिक्वेस्ट session सेशन timeout टाइमआउट retry रिट्राई connect कनेक्ट connected
कनेक्टेड disconnect डिसकनेक्ट connection कनेक्शन pair पेयर paired पेयर्ड pairing पेयरिंग host होस्ट local लोकल
remote रिमोट public पब्लिक private प्राइवेट secure सिक्योर safe सेफ़ safety सेफ़्टी risk रिस्क risky रिस्की
trusted ट्रस्टेड verified वेरिफ़ाइड blocked ब्लॉक्ड block ब्लॉक unblock अनब्लॉक clean क्लीन cleanup क्लीनअप
optimize ऑप्टिमाइज़ performance परफ़ॉर्मेंस speed स्पीड lag लैग freeze फ़्रीज़ hang हैंग load लोड loading लोडिंग
processing प्रोसेसिंग stopped स्टॉप्ड paused पॉज़्ड started स्टार्टेड finished फ़िनिश्ड finish फ़िनिश background
बैकग्राउंड foreground फ़ोरग्राउंड minimize मिनिमाइज़ maximize मैक्सिमाइज़ fullscreen फ़ुलस्क्रीन rotate रोटेट
crop क्रॉप resize रीसाइज़ editor एडिटर format फ़ॉर्मेट convert कन्वर्ट compress कंप्रेस zip ज़िप extract
एक्सट्रैक्ट archive आर्काइव export एक्सपोर्ट import इंपोर्ट merge मर्ज rename रीनेम move मूव duplicate डुप्लिकेट
replace रिप्लेस keyword कीवर्ड tag टैग label लेबल category कैटेगरी kind काइंड stable स्टेबल flash फ़्लैश selfie
सेल्फ़ी portrait पोर्ट्रेट landscape लैंडस्केप effect इफ़ेक्ट record रिकॉर्ड recording रिकॉर्डिंग recorder
रिकॉर्डर playback प्लेबैक headset हेडसेट earbuds ईयरबड्स smartwatch स्मार्टवॉच watch वॉच tracker ट्रैकर calories
कैलोरीज़ protein प्रोटीन vitamin विटामिन prescription प्रिस्क्रिप्शन pharmacy फ़ार्मेसी ambulance एम्बुलेंस
emergency इमरजेंसी police पुलिस fire फ़ायर helpline हेल्पलाइन complaint कंप्लेंट repair रिपेयर warranty वारंटी
care केयर agent एजेंट representative रिप्रेज़ेंटेटिव status स्टेटस track ट्रैक tracking ट्रैकिंग shipment
शिपमेंट courier कूरियर parcel पार्सल package पैकेज pincode पिनकोड city सिटी state स्टेट country कंट्री area
एरिया zone ज़ोन aadhaar आधार pan पैन passport पासपोर्ट license लाइसेंस certificate सर्टिफ़िकेट proof प्रूफ़
signature सिग्नेचर approval अप्रूवल submit सबमिट submitted सबमिटेड fill फ़िल filled फ़िल्ड apply अप्लाई applied
अप्लाइड register रजिस्टर registration रजिस्ट्रेशन renew रिन्यू subscription सब्सक्रिप्शन monthly मंथली yearly
यियरली annual एनुअल daily डेली weekly वीकली conference कॉन्फ़्रेंस webinar वेबिनार agenda एजेंडा followup
फ़ॉलोअप decision डिसीज़न discussion डिस्कशन proposal प्रपोज़ल quotation कोटेशन contract कॉन्ट्रैक्ट agreement
एग्रीमेंट deal डील negotiation नेगोशिएशन sales सेल्स marketing मार्केटिंग campaign कैंपेन brand ब्रांड logo लोगो
ad ऐड ads ऐड्स promotion प्रमोशन reels रील्स shorts शॉर्ट्स trailer ट्रेलर teaser टीज़र clip क्लिप vlog व्लॉग
gaming गेमिंग gamer गेमर lobby लॉबी multiplayer मल्टीप्लेयर pubg पबजी minecraft माइनक्राफ़्ट fortnite फ़ोर्टनाइट
steam स्टीम playstation प्लेस्टेशन xbox एक्सबॉक्स tv टीवी dth डीटीएच recharge रिचार्ज prepaid प्रीपेड postpaid
पोस्टपेड jio जियो airtel एयरटेल vodafone वोडाफ़ोन bsnl बीएसएनएल broadband ब्रॉडबैंड fiber फ़ाइबर uber उबर ola
ओला rapido रैपिडो swiggy स्विगी zomato ज़ोमैटो myntra मिंत्रा meesho मीशो ajio अजियो irctc आईआरसीटीसी makemytrip
मेकमाईट्रिप redbus रेडबस oyo ओयो bookmyshow बुकमायशो fresher फ़्रेशर freshers फ़्रेशर्स intern इंटर्न internship
इंटर्नशिप placement प्लेसमेंट campus कैंपस course कोर्स lecture लेक्चर syllabus सिलेबस topic टॉपिक chapter
चैप्टर unit यूनिट quiz क्विज़ mock मॉक practice प्रैक्टिस revision रिविज़न semester सेमेस्टर degree डिग्री
mathematics मैथमेटिक्स maths मैथ्स physics फ़िज़िक्स chemistry केमिस्ट्री biology बायोलॉजी science साइंस grammar
ग्रामर vocabulary वोकैबुलरी spelling स्पेलिंग translate ट्रांसलेट translation ट्रांसलेशन meaning मीनिंग
dictionary डिक्शनरी pronunciation प्रोनंसिएशन accent एक्सेंट
`;

/**
 * Words Hindi chat borrows from English, by theme: apps and screens, work and office, time and seasons, food and
 * kitchen, travel and places, social talk, money and banking, health and fitness, everyday verbs and adjectives.
 * Brand-free. Words that are also sure Roman Hindi (do, main, to, me, ...) are not here.
 */
const CHAT_WORDS = `
touchscreen टचस्क्रीन touchpad टचपैड webcam वेबकैम powerbank पावरबैंक processor प्रोसेसर graphics ग्राफ़िक्स os ओएस
patch पैच plugin प्लगइन extension एक्सटेंशन dock डॉक fingerprint फ़िंगरप्रिंट biometric बायोमेट्रिक qr क्यूआर
barcode बारकोड emoji इमोजी sticker स्टिकर gif जीआईएफ़ meme मीम hashtag हैशटैग handle हैंडल follower फ़ॉलोअर
subscriber सबस्क्राइबर viewer व्यूअर streaming स्ट्रीमिंग buffering बफ़रिंग buffer बफ़र bandwidth बैंडविड्थ
ethernet ईथरनेट vpn वीपीएन proxy प्रॉक्सी domain डोमेन hosting होस्टिंग ip आईपी ping पिंग latency लेटेंसी
algorithm एल्गोरिदम framework फ़्रेमवर्क library लाइब्रेरी repository रिपॉज़िटरी repo रेपो commit कमिट branch ब्रांच
pull पुल push पुश pipeline पाइपलाइन workflow वर्कफ़्लो automation ऑटोमेशन integration इंटीग्रेशन endpoint एंडपॉइंट
json जेसन xml एक्सएमएल sql एसक्यूएल interface इंटरफ़ेस feature फ़ीचर module मॉड्यूल variable वेरिएबल loop लूप
array ऐरे string स्ट्रिंग compile कंपाइल runtime रनटाइम newsletter न्यूज़लेटर unsubscribe अनसबस्क्राइब sender सेंडर
mention मेंशन trash ट्रैश recycle रीसायकल clipboard क्लिपबोर्ड snapshot स्नैपशॉट bass बेस subtitle सबटाइटल
caption कैप्शन trim ट्रिम layer लेयर brush ब्रश pen पेन pencil पेंसिल notebook नोटबुक diary डायरी printout प्रिंटआउट
photocopy फ़ोटोकॉपी xerox ज़ेरॉक्स cabin केबिन desk डेस्क chair चेयर board बोर्ड whiteboard व्हाइटबोर्ड
projector प्रोजेक्टर slide स्लाइड deck डेक pitch पिच startup स्टार्टअप founder फ़ाउंडर ceo सीईओ colleague कलीग
coworker कोवर्कर supervisor सुपरवाइज़र director डायरेक्टर executive एग्ज़ीक्यूटिव secretary सेक्रेटरी clerk क्लर्क
worker वर्कर vendor वेंडर supplier सप्लायर partner पार्टनर shift शिफ़्ट overtime ओवरटाइम attendance अटेंडेंस
resign रिज़ाइन resignation रिज़िग्नेशन increment इंक्रीमेंट bonus बोनस purchase परचेज़ inventory इन्वेंटरी
warehouse वेयरहाउस logistics लॉजिस्टिक्स supply सप्लाई demand डिमांड quarter क्वार्टर audit ऑडिट
reschedule रीशेड्यूल postpone पोस्टपोन attend अटेंड join जॉइन invite इनवाइट invitation इनविटेशन remind रिमाइंड
assign असाइन assigned असाइन्ड deliver डिलीवर revise रिवाइज़ discuss डिस्कस present प्रेज़ेंट manage मैनेज
organize ऑर्गनाइज़ arrange अरेंज hybrid हाइब्रिड freelance फ़्रीलांस freelancer फ़्रीलांसर season सीज़न summer समर
winter विंटर monsoon मॉनसून spring स्प्रिंग sunrise सनराइज़ sunset सनसेट overdue ओवरड्यू late लेट early अर्ली
sharp शार्प around अराउंड before बिफ़ोर after आफ़्टर pasta पास्ता noodles नूडल्स momos मोमोज़ fries फ़्राइज़
chips चिप्स salad सैलड soup सूप sauce सॉस butter बटर cheese चीज़ egg एग bread ब्रेड toast टोस्ट sugar शुगर
milk मिल्क shake शेक soda सोडा tiffin टिफ़िन buffet बुफ़े dessert डेज़र्ट pastry पेस्ट्री cookie कुकी fruit फ़्रूट
orange ऑरेंज grapes ग्रेप्स vegetable वेजिटेबल veg वेज organic ऑर्गेनिक spicy स्पाइसी sweet स्वीट tasty टेस्टी
delicious डिलीशियस hungry हंग्री fresh फ़्रेश oil ऑयल gas गैस oven ओवन microwave माइक्रोवेव fridge फ़्रिज
cooker कुकर kitchen किचन bottle बॉटल glass ग्लास plate प्लेट spoon स्पून cup कप visa वीज़ा luggage लगेज
baggage बैगेज bag बैग suitcase सूटकेस backpack बैकपैक boarding बोर्डिंग gate गेट checkin चेकइन checkout चेकआउट
reservation रिज़र्वेशन reserve रिज़र्व waiting वेटिंग platform प्लेटफ़ॉर्म coach कोच seat सीट sleeper स्लीपर ac एसी
fare फ़ेयर toll टोल highway हाईवे bridge ब्रिज lane लेन driving ड्राइविंग ride राइड pickup पिकअप helmet हेलमेट
scooter स्कूटर bicycle बाइसिकल cycle साइकिल truck ट्रक van वैन jeep जीप tractor ट्रैक्टर tour टूर tourist टूरिस्ट
resort रिज़ॉर्ट beach बीच trek ट्रेक trekking ट्रेकिंग camping कैंपिंग camp कैंप picnic पिकनिक outing आउटिंग
stay स्टे reception रिसेप्शन lift लिफ़्ट floor फ़्लोर bedroom बेडरूम bathroom बाथरूम toilet टॉयलेट flat फ़्लैट
apartment अपार्टमेंट society सोसाइटी colony कॉलोनी sector सेक्टर street स्ट्रीट near नियर far फ़ार straight स्ट्रेट
turn टर्न exit एग्ज़िट entry एंट्री entrance एंट्रेंस wish विश happy हैप्पी sad सैड excited एक्साइटेड boring बोरिंग
funny फ़नी cute क्यूट lovely लवली awesome ऑसम amazing अमेज़िंग fantastic फ़ैंटास्टिक excellent एक्सीलेंट
brilliant ब्रिलिएंट chill चिल fun फ़न enjoy एंजॉय mood मूड vibe वाइब crush क्रश dating डेटिंग couple कपल
boyfriend बॉयफ़्रेंड girlfriend गर्लफ़्रेंड relationship रिलेशनशिप buddy बडी mate मेट neighbour नेबर
community कम्युनिटी club क्लब celebration सेलिब्रेशन celebrate सेलिब्रेट festival फ़ेस्टिवल concert कॉन्सर्ट dj डीजे
dance डांस singing सिंगिंग cheers चीयर्स bro ब्रो fan फ़ैन atm एटीएम cash कैश cheque चेक statement स्टेटमेंट
banking बैंकिंग savings सेविंग्स saving सेविंग current करंट deposit डिपॉज़िट withdraw विदड्रॉ withdrawal विदड्रॉअल
credited क्रेडिटेड debited डेबिटेड wallet वॉलेट kyc केवाईसी principal प्रिंसिपल installment इंस्टॉलमेंट due ड्यू
penalty पेनल्टी charges चार्जेस charge चार्ज fee फ़ी commission कमीशन mutual म्यूचुअल equity इक्विटी coin कॉइन
euro यूरो pound पाउंड currency करेंसी exchange एक्सचेंज rate रेट return रिटर्न cashless कैशलेस pension पेंशन
pf पीएफ़ claim क्लेम renewal रिन्यूअल membership मेंबरशिप voucher वाउचर bargain बारगेन bp बीपी diabetes डायबिटीज़
thyroid थायरॉइड cholesterol कोलेस्ट्रॉल allergy एलर्जी infection इन्फ़ेक्शन flu फ़्लू covid कोविड vaccine वैक्सीन
vaccination वैक्सीनेशन dose डोज़ capsule कैप्सूल syrup सिरप injection इंजेक्शन mask मास्क sanitizer सैनिटाइज़र
oxygen ऑक्सीजन ward वार्ड surgery सर्जरी operation ऑपरेशन specialist स्पेशलिस्ट therapy थेरेपी therapist थेरेपिस्ट
sample सैंपल lab लैब blood ब्लड pressure प्रेशर pulse पल्स heartbeat हार्टबीट heart हार्ट anxiety एंग्ज़ाइटी
depression डिप्रेशन meditation मेडिटेशन mindfulness माइंडफ़ुलनेस weight वेट calorie कैलोरी workout वर्कआउट
cycling साइक्लिंग swimming स्विमिंग trainer ट्रेनर supplement सप्लीमेंट immunity इम्युनिटी try ट्राई tried ट्राइड
used यूज़्ड using यूज़िंग work वर्क working वर्किंग worked वर्क्ड need नीड want वांट love लव hate हेट feel फ़ील
think थिंक know नो remember रिमेंबर forget फ़ॉरगेट keep कीप take टेक give गिव make मेक pick पिक respond रिस्पॉन्ड
react रिएक्ट reaction रिएक्शन accept एक्सेप्ट decline डिक्लाइन ignore इग्नोर avoid अवॉइड catch कैच prepare प्रिपेयर
learn लर्न learning लर्निंग explain एक्सप्लेन understand अंडरस्टैंड confuse कन्फ़्यूज़ confused कन्फ़्यूज़्ड
confusing कन्फ़्यूज़िंग sure श्योर maybe मेबी probably प्रोबेबली actually एक्चुअली basically बेसिकली
seriously सीरियसली exactly एग्ज़ैक्टली totally टोटली just जस्ट only ओनली also ऑल्सो even ईवन still स्टिल
already ऑलरेडी really रियली very वेरी much मच many मेनी more मोर most मोस्ट less लेस enough इनफ़ almost ऑलमोस्ट
tension टेंशन confidence कॉन्फ़िडेंस attitude एटीट्यूड style स्टाइल stylish स्टाइलिश fashion फ़ैशन
trending ट्रेंडिंग viral वायरल popular पॉपुलर famous फ़ेमस original ओरिजिनल fake फ़ेक real रियल genuine जेन्युइन
official ऑफ़िशियल legal लीगल illegal इलीगल valid वैलिड invalid इनवैलिड correct करेक्ट wrong रॉन्ग exact एग्ज़ैक्ट
accurate एक्यूरेट careful केयरफ़ुल serious सीरियस crazy क्रेज़ी lazy लेज़ी smart स्मार्ट positive पॉज़िटिव
negative नेगेटिव neutral न्यूट्रल comfortable कंफ़र्टेबल comfort कंफ़र्ट tired टायर्ड relax रिलैक्स rest रेस्ट
break ब्रेक peace पीस bright ब्राइट light लाइट
`;

/** English words said inside Hindi text, written in Devanagari. */
export const ENGLISH_IN_HINDI = `${TECH}\n${TIME_AND_PLACE}\n${MONEY_AND_LIFE}\n${GENERAL}\n${WORK_AND_WORLD}\n${CHAT_WORDS}`;

/**
 * Roman Hindi that no English word shares. Safe to turn into Devanagari once the sentence is Hinglish
 * (or already holds Devanagari).
 */
export const ROMAN_HINDI_STRONG = `
aaj आज kal कल parso परसों abhi अभी ab अब phir फिर fir फिर kabhi कभी hamesha हमेशा subah सुबह shaam शाम raat रात
dopahar दोपहर savere सवेरे mera मेरा meri मेरी mere मेरे mujhe मुझे mujhko मुझको mein में meinne मैंने hamara
हमारा hamari हमारी hamare हमारे tumhara तुम्हारा tumhari तुम्हारी tumhare तुम्हारे tumhe तुम्हें tumko तुमको aap
आप aapka आपका aapki आपकी aapke आपके aapko आपको aapse आपसे ye ये yeh यह wo वो woh वह vo वो inka इनका inki इनकी
inke इनके unka उनका unki उनकी unke उनके uska उसका uski उसकी uske उसके iska इसका iski इसकी iske इसके kaun कौन kya
क्या kyun क्यों kyu क्यों kyon क्यों kaise कैसे kaisa कैसा kaisi कैसी kab कब kahan कहाँ kidhar किधर kitna कितना
kitni कितनी kitne कितने kaunsa कौनसा kaunsi कौनसी kisne किसने kisko किसको kisi किसी koi कोई kuch कुछ sab सब
sabhi सभी sirf सिर्फ़ bas बस bahut बहुत zyada ज़्यादा jyada ज़्यादा kam कम thoda थोड़ा thodi थोड़ी thode थोड़े
bilkul बिल्कुल zaroor ज़रूर zarur ज़रूर shayad शायद pakka पक्का theek ठीक thik ठीक sahi सही galat ग़लत accha
अच्छा acha अच्छा achha अच्छा achchha अच्छा bura बुरा naya नया nayi नई purana पुराना bada बड़ा badi बड़ी chhota
छोटा chhoti छोटी lamba लंबा jaldi जल्दी dheere धीरे hai है hain हैं ho हो hoga होगा hogi होगी honge होंगे tha था
thi थी raha रहा rahi रही rahe रहे karo करो karna करना karni करनी karne करने kare करे karta करता karti करती karte
करते kiya किया kiye किए kar कर ki की ke के ka का ko को se से pe पे tak तक liye लिए wala वाला wali वाली wale वाले
aur और lekin लेकिन magar मगर kyunki क्योंकि isliye इसलिए agar अगर toh तो bhi भी nahi नहीं nahin नहीं haan हाँ
han हाँ ji जी dena देना jao जाओ jana जाना jaana जाना aao आओ aana आना bhej भेज bhejo भेजो bhejna भेजना batao बताओ
batana बताना dikhao दिखाओ dikha दिखा dekho देखो dekhna देखना suno सुनो sunna सुनना bolo बोलो bolna बोलना likho
लिखो likhna लिखना padho पढ़ो padhna पढ़ना kholo खोलो kholna खोलना chalo चलो chalu चालू ruko रुको rukna रुकना
uthao उठाओ rakho रखो rakhna रखना milo मिलो milna मिलना milega मिलेगा milegi मिलेगी chahiye चाहिए chahta चाहता
chahti चाहती chahte चाहते sakta सकता sakti सकती sakte सकते padega पड़ेगा padta पड़ता lagta लगता lagti लगती hona
होना hua हुआ hui हुई hue हुए gaya गया gayi गई gaye गए aaya आया aayi आई aaye आए mila मिला mili मिली diya दिया
liya लिया kaam काम baat बात ghar घर paise पैसे paisa पैसा rupaye रुपये rupay रुपये hazaar हज़ार hazar हज़ार sau
सौ saal साल mahina महीना mahine महीने hafta हफ़्ता hafte हफ़्ते samay समय baje बजे ghanta घंटा ghante घंटे khana
खाना paani पानी chai चाय doodh दूध dost दोस्त yaar यार bhai भाई behen बहन papa पापा beti बेटी bhaiya
भैया didi दीदी naam नाम sawal सवाल jawab जवाब madad मदद dikkat दिक्कत khabar ख़बर kahani कहानी gaana गाना bazaar
बाज़ार dukaan दुकान sheher शहर desh देश gaon गाँव agla अगला agli अगली pichla पिछला pehle पहले baad बाद pehla
पहला doosra दूसरा teesra तीसरा ek एक teen तीन chaar चार paanch पाँच chhe छह chhah छह saat सात aath आठ nau नौ das
दस gyarah ग्यारह barah बारह pandrah पंद्रह bees बीस tees तीस chalis चालीस pachas पचास somwar सोमवार mangalwar
मंगलवार budhwar बुधवार guruwar गुरुवार shukrawar शुक्रवार shaniwar शनिवार raviwar रविवार itwar इतवार yahan यहाँ
wahan वहाँ idhar इधर udhar उधर upar ऊपर neeche नीचे andar अंदर bahar बाहर saath साथ bina बिना sath साथ phele
पहले pehli पहली jab जब jabtak जबतक tabtak तबतक kahin कहीं sabse सबसे bahot बहुत bohot बहुत kaafi काफ़ी
shukriya शुक्रिया dhanyavaad धन्यवाद namaste नमस्ते namaskar नमस्कार alvida अलविदा maaf माफ़ maafi माफ़ी kripya
कृपया zindagi ज़िंदगी duniya दुनिया waqt वक़्त dil दिल dimaag दिमाग़ pyaar प्यार mohabbat मोहब्बत khush ख़ुश
udaas उदास gussa ग़ुस्सा thaka थका thaki थकी bhookh भूख pyaas प्यास neend नींद sapna सपना sach सच jhoot झूठ
mushkil मुश्किल aasaan आसान hoon हूँ hu हूँ hota होता hoti होती hote होते rehta रहता rehti रहती rehna रहना raho
रहो batayein बताएँ kijiye कीजिए kariye कीजिए dijiye दीजिए dekhiye देखिए suniye सुनिए boliye बोलिए chaliye चलिए
aaiye आइए baithiye बैठिए lagao लगाओ lagana लगाना hatao हटाओ hatana हटाना badlo बदलो badalna बदलना banao बनाओ
banana बनाना bana बना banaya बनाया chalao चलाओ chalana चलाना shuru शुरू khatam ख़त्म poora पूरा pura पूरा
adhoora अधूरा
`;

/** Roman Hindi that is also an English word. Turned into Devanagari only inside a sentence that is already Hinglish. */
export const ROMAN_HINDI_WEAK = `
do दो main मैं to तो hum हम tum तुम par पर ya या mat मत na ना lo लो le ले de दे ja जा aa आ bata बता khol खोल ruk
रुक band बंद din दिन log लोग per पर me में beta बेटा tab तब
`;
