const express = require("express");
const nodemailer = require("nodemailer");

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://registro-epi-limpieza.onrender.com";
const GMAIL_USER = (process.env.GMAIL_USER || "").trim();
const GMAIL_APP_PASSWORD = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
const FROM_NAME = process.env.FROM_NAME || "Registro EPI · CLUMTEL PREMIUM, SL";
const emailRe = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
// Destinatario(s) fijo(s) en el servidor: los trabajadores no pueden cambiarlo. Admite varios separados por comas.
const DEST = (process.env.DEST_EMAIL || "").split(/[,;]/).map(s => s.trim()).filter(Boolean);
const DEST_OK = DEST.length > 0 && DEST.every(x => emailRe.test(x));

const app = express();
app.use(express.json({ limit: "15mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 3600e3, max = 40;
  const arr = (hits.get(ip) || []).filter(t => now - t < win);
  arr.push(now); hits.set(ip, arr);
  return arr.length > max;
}
const clean = (s, n) => String(s || "").replace(/[\r\n]+/g, " ").trim().slice(0, n);

let transporter = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: "smtp.gmail.com", port: 465, secure: true,
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
      connectionTimeout: 15000, socketTimeout: 30000
    });
  }
  return transporter;
}

app.get("/", (req, res) => res.json({
  ok: true,
  configured: !!(GMAIL_USER && GMAIL_APP_PASSWORD && DEST_OK),
  mail: !!(GMAIL_USER && GMAIL_APP_PASSWORD),
  destination: DEST_OK
}));

app.post("/api/enviar", async (req, res) => {
  try {
    if (!GMAIL_USER || !GMAIL_APP_PASSWORD) return res.status(503).json({ error: "El servidor de correo no está configurado (faltan GMAIL_USER / GMAIL_APP_PASSWORD)." });
    if (!DEST_OK) return res.status(503).json({ error: "No hay destinatario configurado para los certificados (falta DEST_EMAIL)." });
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?";
    if (limited(String(ip).split(",")[0])) return res.status(429).json({ error: "Demasiados envíos. Inténtalo más tarde." });
    const b = req.body || {};
    const pdf = Buffer.from(String(b.pdfBase64 || ""), "base64");
    if (pdf.length < 500 || pdf.slice(0, 4).toString() !== "%PDF") return res.status(400).json({ error: "PDF no válido." });
    const trabajador = clean(b.trabajador, 100), dni = clean(b.dni, 20), hotel = clean(b.hotel, 150), fecha = clean(b.fecha, 12);
    if (!trabajador || !dni) return res.status(400).json({ error: "Faltan los datos del trabajador/a." });
    const epis = (Array.isArray(b.epis) ? b.epis : []).slice(0, 10).map(x => clean(x, 200)).filter(Boolean);
    if (!epis.length) return res.status(400).json({ error: "No se ha marcado ningún EPI entregado." });
    const copia = clean(b.copia, 120);
    const cc = copia && emailRe.test(copia) ? copia : undefined;
    const filename = clean(b.filename, 100).replace(/[^\w.\- ]/g, "_") || "registro-entrega-epi.pdf";
    const subject = `Registro de entrega de EPI – ${trabajador} – ${fecha}${hotel ? " – " + hotel : ""}`;
    const text = `Se adjunta el registro de entrega de equipos de protección individual firmado.

Empresa: CLUMTEL PREMIUM, SL
Puesto: Personal de limpieza
Trabajador/a: ${trabajador} (DNI ${dni})
Fecha: ${fecha}
Hotel / centro: ${hotel || "-"}

EPI entregados:
${epis.map(e => " - " + e).join("\n")}

Mensaje generado automáticamente por la aplicación de registro de EPI. Por favor, no responda a este correo.
Documento cedido por PREVIJOB SL`;
    await getTransporter().sendMail({
      from: `"${FROM_NAME}" <${GMAIL_USER}>`,
      to: DEST.join(", "), cc, subject, text,
      attachments: [{ filename, content: pdf, contentType: "application/pdf" }]
    });
    res.json({ ok: true });
  } catch (e) {
    console.error("Error enviando:", e && e.message);
    res.status(502).json({ error: "No se pudo enviar el correo: " + (e && e.code || e && e.message || "error") });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("registro-epi-limpieza-api en puerto " + port));
