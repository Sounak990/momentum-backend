import express from "express";
import admin from "firebase-admin";
import { google } from "googleapis";
import dotenv from "dotenv";

dotenv.config();

const app = express();

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = "https://your-vercel-domain.vercel.app/api/callback"; // update after deployment

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

// ✅ STEP 1: Start Google OAuth
app.get("/api/auth", (req, res) => {
  const scopes = ["https://www.googleapis.com/auth/calendar"];
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes,
  });
  res.redirect(url);
});

// ✅ STEP 2: Handle Google callback
app.get("/api/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing code.");

  try {
    const { tokens } = await oauth2Client.getToken(code);
    const uid = "testUser"; // Replace with your real user ID

    await db.collection("users").doc(uid).collection("private").doc("googleAuth").set({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.send("✅ Google Calendar connected successfully!");
  } catch (err) {
    console.error("Error:", err);
    res.status(500).send("Error connecting Google account.");
  }
});

// ✅ Optional: Warm-up test
app.get("/api/ping", (req, res) => res.send("Server running fine ✅"));

export default app;
