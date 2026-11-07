import OpenAI from "openai";
const openai = new OpenAI();

export async function verify(token: string) {
  const res = await fetch(`https://payments.example.com/verify/${token}`, { method: "POST" });
  return res.json();
}

export async function dashboard(userId: string) {
  const profile = await getProfile(userId);
  const orders = await getOrders(userId);
  const stats = await getStats(userId);
  return { profile, orders, stats };
}

export async function summarize(text: string) {
  const r = await openai.chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: text }] });
  return r.choices[0].message.content;
}
