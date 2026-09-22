# Android APK (TWA / Bubblewrap)

APK বানাতে **প্রথমবার আপনার নিজের কম্পিউটারে একবার** সেটআপ করতে হয় (Google-এর সরকারি টুল Bubblewrap ইন্টারনেট ও
Android SDK/keytool ব্যবহার করে একটি Android প্রজেক্ট বানায় ও সাইনিং-কি তৈরি করে — এটা GitHub Actions-এ প্রথমবার
নিরাপদে/সহজে করা যায় না, কারণ সাইনিং পাসওয়ার্ড আপনাকেই ঠিক করতে হয়)। এরপর থেকে GitHub Actions
(`.github/workflows/android.yml`) নিজে থেকেই নতুন APK বানাবে, যতবার `Code.gs`/`web/` বদলে পুশ করবেন।

## ধাপ ১ — একবার, নিজের কম্পিউটারে

শর্ত: Node.js ও JDK 17 ইনস্টল থাকতে হবে। প্রথমবার ইন্টারনেট লাগবে (Android SDK নামানোর জন্য)।

```bash
npm i -g @bubblewrap/cli
# আপনার GitHub Pages ঠিকানা দিয়ে (আগে GitHub Pages ডিপ্লয় করে নিন — ধাপ ২, README.md দেখুন):
bubblewrap init --manifest https://<আপনার-ইউজারনেম>.github.io/<রিপো-নাম>/manifest.webmanifest --directory twa
```

প্রশ্নগুলোর বেশিরভাগেই এন্টার চেপে ডিফল্ট রাখা যায় (অ্যাপের নাম, রং, আইকন — সব manifest.webmanifest থেকেই নেওয়া হয়)।
শুধু **প্যাকেজ আইডি** (যেমন `com.riponmanagement.app`) আর **সাইনিং-কি বানানোর সময় দুটি পাসওয়ার্ড** নিজে ঠিক করুন —
**এই পাসওয়ার্ড দুটি লিখে রাখুন, হারালে ভবিষ্যতে APK আপডেট করা যাবে না।**

শেষে `twa/` ফোল্ডারে প্রজেক্ট আর `twa/android.keystore` ফাইল তৈরি হবে।

## ধাপ ২ — GitHub Secrets-এ কি জমা রাখা

```bash
base64 -w0 twa/android.keystore > keystore.b64   # (Mac-এ: base64 -i twa/android.keystore)
```

রিপোর **Settings → Secrets and variables → Actions**-এ ৩টি secret বানান:
- `ANDROID_KEYSTORE_BASE64` — `keystore.b64`-এর পুরো লেখা
- `ANDROID_KEYSTORE_PASSWORD` — কিস্টোর পাসওয়ার্ড
- `ANDROID_KEY_PASSWORD` — কি পাসওয়ার্ড

তারপর `twa/android.keystore` **কখনোই** GitHub-এ পুশ করবেন না (এটা `.gitignore`-এ বাদ দেওয়া আছে); বাকি `twa/` ফোল্ডার
(`twa-manifest.json`, `app/`, ইত্যাদি — `.gitignore`-এ যা বাদ যায়নি) পুশ করুন।

## ধাপ ৩ — এরপর থেকে, GitHub-ই বানাবে

**Actions → Build Android APK → Run workflow** চাপুন (বা `twa/` ফোল্ডারে পরিবর্তন পুশ করলে এমনিই চলবে)।
সফল হলে Artifacts-এ `ripon-android-apk` নামে সই করা (signed) APK পাওয়া যাবে — ডাউনলোড করে ফোনে ইনস্টল করুন
("Unknown apps" ইনস্টলের অনুমতি লাগতে পারে)।

## Secret ছাড়া চেষ্টা (শুধু নিজে পরীক্ষা করতে — Play Store-এর জন্য নয়)

তিনটি secret না দিলে workflow নিজে একটা **অস্থায়ী ডিবাগ কি** বানিয়ে APK সই করে — প্রতিবার নতুন কি হয়, তাই এভাবে
বানানো APK **আপডেট করা যায় না** (আগেরটা আনইনস্টল করে নতুনটা বসাতে হয়)। সিরিয়াসলি ব্যবহার করতে চাইলে ধাপ ১-২ করুন।

## twa-manifest.json এখনও নেই?

এই workflow প্রথমে `twa/twa-manifest.json` আছে কিনা দেখে — না থাকলে এই README দেখিয়ে থেমে যায় (ব্যর্থ হয় না,
তাই এটা Pages ডিপ্লয়কে আটকায় না)।
