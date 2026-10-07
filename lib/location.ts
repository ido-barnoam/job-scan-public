import type { LocationClass, RawJob } from "./types";

// Cheap first pass. Clear cases are decided here; anything vague ("Remote",
// "EMEA", "Multiple locations") is left to Jev as "ambiguous".
const ISRAEL = [
  "israel", "tel aviv", "tel-aviv", "tlv", "herzliya", "herzlia", "haifa", "jerusalem", "ramat gan", "ramat-gan",
  "petah tikva", "petach tikva", "netanya", "raanana", "ra'anana", "or yehuda", "yokneam", "yoqneam", "beer sheva",
  "be'er sheva", "rehovot", "hod hasharon", "kfar saba", "modi'in", "modiin", "caesarea", "rosh ha'ayin",
  "rosh haayin", "bnei brak", "givatayim", "airport city", "lod", "kadima", "holon", "rishon", "ashdod", "nazareth",
  "migdal haemek", "yavne", "ness ziona", "nes ziona", "ramat hasharon", "rosh pina", "tel aviv-yafo", "jaffa",
];
const VAGUE = ["remote", "emea", "europe", "global", "anywhere", "worldwide", "international", "multiple", "various", "hybrid"];

export function classifyLocation(j: RawJob): LocationClass {
  const loc = j.location.toLowerCase();
  if (j.country && ["il", "isr", "israel"].includes(j.country.toLowerCase())) return "israel";
  if (ISRAEL.some((w) => loc.includes(w))) return "israel";
  if (!loc.trim() || j.remote || VAGUE.some((w) => loc.includes(w))) return "ambiguous";
  return "elsewhere";
}
