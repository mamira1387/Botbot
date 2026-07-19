const { Bot, webhookCallback, InlineKeyboard } = require("grammy");
const { createClient } = require("@supabase/supabase-js");

// --- تنظیمات اولیه و اتصال به Supabase ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = parseInt(process.env.OWNER_ID);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const bot = new Bot(BOT_TOKEN);

// --- توابع کمکی تبدیل متن به عدد دپث‌تون ---
function parseAmount(text) {
    let clean = text.toLowerCase().trim();
    const farsiDigits = ['۰','۱','۲','۳','۴','۵','۶','۷','۸','۹'];
    const engDigits = ['0','1','2','3','4','5','6','7','8','9'];
    for (let i = 0; i < 10; i++) {
        clean = clean.replace(new RegExp(farsiDigits[i], 'g'), engDigits[i]);
    }
    clean = clean.replace(/دپث|تون/g, '').trim();
    
    const match = clean.match(/^([0-9.]+)\s*(k|کا)?$/);
    if (!match) return null;
    
    let value = parseFloat(match[1]);
    if (match[2] === 'k' || match[2] === 'کا') {
        value *= 1000;
    }
    return value;
}

async function registerUser(userId, username) {
    await supabase.from('users').upsert({ user_id: userId, username: username || '' }, { onConflict: 'user_id' });
}

async function isAdmin(userId) {
    if (userId === OWNER_ID) return true;
    const { data } = await supabase.from('admins').select('telegram_id').eq('telegram_id', userId).single();
    return !!data;
}

// --- متن راهنمای ربات ---
const helpText = `📚 **راهنمای کامل ربات کیف پول مجازی دپث‌تون**

💳 **دستورات عمومی کاربران:**
• /wallet - مشاهده موجودی و شناسه ولت
• /help - نمایش همین راهنما

💸 **روش‌های انتقال دپث‌تون:**
۱. **روش ریپلای:** روی پیام فرد ریپلای کنید و مبلغ را بفرستید (مثال: \`10k\` یا \`۱۰کا\` یا \`5000\`).
۲. **روش آیدی ولت:** متن زیر را بفرستید:
\`انتقال 10k به 12345678\` (جای عدد آخر، شناسه ولت شخص را بزنید).

🧾 **ساخت قبض:**
• متن روبرو را بفرستید: \`ساخت قبض ۱۰کا دپث ۵ بار مصرف\`

⚙️ **دستورات ادمین و مالک:**
• \`/login username password\` - ورود ادمین‌ها
• \`add ton 10k\` - افزایش موجودی (ریپلای یا نوشتن آیدی در آخر)
• \`کسر 10k\` - کم کردن موجودی (ریپلای یا نوشتن آیدی در آخر)

👑 **دستورات ویژه مالک:**
• \`/addadmin user pass\` | \`/deladmin user\``;

// --- دستورات ربات ---
bot.command("help", async (ctx) => {
    await ctx.reply(helpText, { parse_mode: "Markdown" });
});

bot.command("wallet", async (ctx) => {
    const userId = ctx.from.id;
    await registerUser(userId, ctx.from.username);
    const { data } = await supabase.from('users').select('balance').eq('user_id', userId).single();
    const balance = data ? data.balance : 0;
    
    await ctx.reply(`💳 **کیف پول شما**\n\n🆔 شناسه ولت شما: \`${userId}\`\n💰 موجودی: **${balance.toLocaleString()} دپث تون**`, { parse_mode: "Markdown" });
});

bot.command("addadmin", async (ctx) => {
    if (ctx.from.id !== OWNER_ID) return;
    const args = ctx.match.split(" ");
    if (args.length >= 2) {
        await supabase.from('admins').upsert({ username: args[0], password: args[1] });
        await ctx.reply(`✅ ادمین ${args[0]} با موفقیت ساخته شد.`);
    }
});

bot.command("deladmin", async (ctx) => {
    if (ctx.from.id !== OWNER_ID) return;
    const username = ctx.match.trim();
    if (username) {
        await supabase.from('admins').delete().eq('username', username);
        await ctx.reply(`❌ ادمین ${username} حذف شد.`);
    }
});

bot.command("login", async (ctx) => {
    const args = ctx.match.split(" ");
    if (args.length >= 2) {
        const { data } = await supabase.from('admins').select('password').eq('username', args[0]).single();
        if (data && data.password === args[1]) {
            await supabase.from('admins').update({ telegram_id: ctx.from.id }).eq('username', args[0]);
            await ctx.reply("✅ با موفقیت به عنوان ادمین وارد شدید و اکانت شما ثبت شد.");
        } else {
            await ctx.reply("❌ نام کاربری یا رمز عبور اشتباه است.");
        }
    }
});

// --- هندل کردن دکمه‌های شیشه‌ای تایید ---
bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const fromId = ctx.from.id;

    if (data === "tx_cancel") {
        await ctx.editMessageText("❌ انتقال توسط فرستنده لغو شد.");
        return;
    }

    if (data.startsWith("tx_confirm_")) {
        const [, , senderIdStr, toIdStr, amountStr] = data.split("_");
        const senderId = parseInt(senderIdStr);
        const toId = parseInt(toIdStr);
        const amount = parseFloat(amountStr);

        if (fromId !== senderId) return; // فقط فرستنده اصلی حق تایید دارد

        if (!(await isAdmin(senderId))) {
            const { data: userData } = await supabase.from('users').select('balance').eq('user_id', senderId).single();
            if (!userData || userData.balance < amount) {
                await ctx.editMessageText("❌ تراکنش ناموفق. موجودی شما کافی نیست.");
                return;
            }
            await supabase.rpc('increment_balance', { x: -amount, row_id: senderId }); // یا کوئری آپدیت معمولی
            await supabase.from('users').update({ balance: userData.balance - amount }).eq('user_id', senderId);
        }

        const { data: targetData } = await supabase.from('users').select('balance').eq('user_id', toId).single();
        const targetBalance = targetData ? targetData.balance : 0;
        await supabase.from('users').upsert({ user_id: toId, balance: targetBalance + amount });

        await ctx.editMessageText(`✅ مقدار **${amount.toLocaleString()} دپث تون** از آیدی \`${senderId}\` به آیدی \`${toId}\` با موفقیت انتقال یافت.`, { parse_mode: "Markdown" });
    }

    if (data.startsWith("claim_bill_")) {
        const billId = data.replace("claim_bill_", "");
        const { data: bill } = await supabase.from('bills').select('*').eq('bill_id', billId).single();
        if (!bill) return;

        let claimers = bill.claimers ? bill.claimers.split(",") : [];
        if (claimers.includes(fromId.toString())) return; // استفاده تکراری ممنوع

        if (bill.current_uses >= bill.max_uses) {
            await ctx.editMessageText("❌ ظرفیت استفاده از این قبض به پایان رسیده است.");
            return;
        }

        await registerUser(fromId, ctx.from.username);
        claimers.push(fromId.toString());
        const newUses = bill.current_uses + 1;
        const remaining = bill.max_uses - newUses;

        await supabase.from('bills').update({ current_uses: newUses, claimers: claimers.join(",") }).eq('bill_id', billId);
        
        const { data: userData } = await supabase.from('users').select('balance').eq('user_id', fromId).single();
        const currentBalance = userData ? userData.balance : 0;
        await supabase.from('users').upsert({ user_id: fromId, balance: currentBalance + bill.amount });

        const mentions = claimers.map(id => `\`${id}\``).join(", ");
        const keyboard = remaining > 0 ? new InlineKeyboard().text("💰 دریافت دپث تون", `claim_bill_${billId}`) : undefined;

        await ctx.editMessageText(`🧾 **پرداخت قبض**\n💰 قیمت: **${bill.amount.toLocaleString()} دپث تون**\n🔄 تعداد بار مصرف باقی‌مانده: **${remaining}**\n👥 آیدی دریافت‌کنندگان: ${mentions}`, {
            parse_mode: "Markdown",
            reply_markup: keyboard
        });
    }
});

// --- هندل کردن متن‌ها و دستورات عامیانه ---
bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const fromId = ctx.from.id;

    await registerUser(fromId, ctx.from.username);

    // ۱. دستورات مدیریت موجودی ادمین (Add ton / کسر)
    const isAdd = /add ton|add_ton/i.test(text);
    const isSub = text.includes("کسر");
    if ((isAdd || isSub) && (await isAdmin(fromId))) {
        let clean = text.replace(/add ton|add_ton|کسر/gi, "");
        let targetId = null;

        if (ctx.message.reply_to_message) {
            targetId = ctx.message.reply_to_message.from.id;
        } else {
            const matches = clean.match(/\d+/g);
            if (matches) {
                for (let num of matches) {
                    if (num.length > 5) { targetId = parseInt(num); break; }
                }
            }
        }

        const amount = parseAmount(clean);
        if (targetId && amount > 0) {
            const { data: userData } = await supabase.from('users').select('balance').eq('user_id', targetId).single();
            let currentBalance = userData ? userData.balance : 0;
            let newBalance = isAdd ? currentBalance + amount : Math.max(0, currentBalance - amount);
            
            await supabase.from('users').upsert({ user_id: targetId, balance: newBalance });
            await ctx.reply(`🔋 موجودی ولت \`${targetId}\` به مقدار **${amount.toLocaleString()} دپث تون** توسط ادمین ${isAdd ? 'افزایش' : 'کاهش'} یافت.`, { parse_mode: "Markdown" });
        }
        return;
    }

    // ۲. ساخت قبض
    if (text.startsWith("ساخت قبض")) {
        let clean = text.replace("ساخت قبض", "").trim();
        let maxUses = 1;
        const usesMatch = clean.match(/(\d+)\s*بار/);
        if (usesMatch) {
            maxUses = parseInt(usesMatch[1]);
            clean = clean.replace(/\d+\s*بار\s*مصرف/, "").trim();
        }
        const amount = parseAmount(clean);
        if (amount > 0) {
            if (!(await isAdmin(fromId))) {
                const { data: userData } = await supabase.from('users').select('balance').eq('user_id', fromId).single();
                if (!userData || userData.balance < (amount * maxUses)) {
                    await ctx.reply("❌ موجودی شما برای ساخت این قبض کافی نیست.");
                    return;
                }
                await supabase.from('users').update({ balance: userData.balance - (amount * maxUses) }).eq('user_id', fromId);
            }
            const billId = Math.random().toString(36).substring(2, 10);
            await supabase.from('bills').insert({ bill_id: billId, amount: amount, max_uses: maxUses, creator_id: fromId });

            const keyboard = new InlineKeyboard().text("💰 دریافت دپث تون", `claim_bill_${billId}`);
            await ctx.reply(`🧾 **پرداخت قبض**\n💰 قیمت: **${amount.toLocaleString()} دپث تون**\n🔄 تعداد بار مصرف باقی‌مانده: **${maxUses}**\n👥 آیدی دریافت‌کنندگان: _هنوز کسی دریافت نکرده_`, {
                parse_mode: "Markdown",
                reply_markup: keyboard
            });
        }
        return;
    }

    // ۳. انتقال مستقیم با آیدی ولت (انتقال 10k به 12345678)
    if (text.startsWith("انتقال")) {
        const match = text.match(/انتقال\s+(.+?)\s+به\s+(\d+)/i);
        if (match) {
            const amount = parseAmount(match[1]);
            const toId = parseInt(match[2]);

            if (amount && amount > 0 && fromId !== toId) {
                if (!(await isAdmin(fromId))) {
                    const { data: userData } = await supabase.from('users').select('balance').eq('user_id', fromId).single();
                    if (!userData || userData.balance < amount) {
                        await ctx.reply("❌ موجودی شما کافی نیست!");
                        return;
                    }
                }
                const keyboard = new InlineKeyboard()
                    .text("✅ تایید انتقال", `tx_confirm_${fromId}_${toId}_${amount}`)
                    .text("❌ لغو", "tx_cancel");

                await ctx.reply(`❓ آیا از انتقال **${amount.toLocaleString()} دپث تون** به ولت با شناسه \`${toId}\` مطمئن هستید؟`, {
                    parse_mode: "Markdown",
                    reply_markup: keyboard
                });
            }
        }
        return;
    }

    // ۴. انتقال با ریپلای ساده (مثل 10k)
    const amount = parseAmount(text);
    if (amount && amount > 0 && ctx.message.reply_to_message) {
        const toId = ctx.message.reply_to_message.from.id;
        if (ctx.message.reply_to_message.from.is_bot || fromId === toId) return;

        if (!(await isAdmin(fromId))) {
            const { data: userData } = await supabase.from('users').select('balance').eq('user_id', fromId).single();
            if (!userData || userData.balance < amount) {
                await ctx.reply("❌ موجودی شما کافی نیست!");
                return;
            }
        }
        const keyboard = new InlineKeyboard()
            .text("✅ تایید انتقال", `tx_confirm_${fromId}_${toId}_${amount}`)
            .text("❌ لغو", "tx_cancel");

        await ctx.reply(`❓ آیا از انتقال **${amount.toLocaleString()} دپث تون** به کاربر مطمئن هستید؟`, {
            parse_mode: "Markdown",
            reply_markup: keyboard
        });
    }
});

// اکسپورت به عنوان هندلر برای Vercel Serverless
const cb = webhookCallback(bot, "http");

module.exports = async (req, res) => {
    // اگر درخواست از نوع POST نبود (مثلاً باز کردن لینک در مرورگر)، بدون ارور پاسخ بده
    if (req.method !== "POST") {
        res.statusCode = 200;
        res.end("Bot is running... Please send POST requests from Telegram.");
        return;
    }
    // اجرا و مدیریت وب‌هوک تلگرام
    return cb(req, res);
};

