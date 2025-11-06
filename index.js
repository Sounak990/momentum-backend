import express from "express";
import admin from "firebase-admin";
import { google } from "googleapis";
import dotenv from "dotenv";
import cors from "cors";

// --- Configuration ---
dotenv.config();
const app = express();

// ✅ 1. FIX: CORS Configuration
// This allows your React app (on localhost) to talk to this backend (on Vercel)
const corsOptions = {
  origin: [
    "http://localhost:3000",
    "https://my-habit-tracker-ca41a.web.app"
    // 💡 Add your DEPLOYED frontend URL here when you have one
    // "https://your-momentum-frontend.vercel.app" 
  ],
  optionsSuccessStatus: 200,
};
app.use(cors(corsOptions));
app.use(express.json());

// --- Firebase Admin Setup ---
if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } catch (e) {
    console.error("Failed to initialize Firebase Admin:", e.message);
    console.log("Make sure FIREBASE_SERVICE_ACCOUNT env variable is set correctly.");
  }
}
const db = admin.firestore();
const auth = admin.auth(); // <-- We need this to verify users

// --- Google OAuth2 Setup ---
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// ✅ 2. FIX: Correct Vercel URL
// This MUST match the URL in your App.js and your Google Cloud Console
const REDIRECT_URI = "https://momentum-backend-lm62x1bnm-sounak990s-projects.vercel.app/api/callback";

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

// --- Middleware ---

/**
 * @description Verifies the Firebase ID token sent from the frontend.
 * This middleware protects your endpoints.
 */
const verifyFirebaseToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(403).send("Unauthorized: No token provided.");
  }

  const idToken = authHeader.split("Bearer ")[1];
  try {
    const decodedToken = await auth.verifyIdToken(idToken);
    req.uid = decodedToken.uid; // Attach user's UID to the request
    next();
  } catch (error) {
    console.error("Error verifying token:", error);
    return res.status(403).send("Unauthorized: Invalid token.");
  }
};

// --- API Endpoints ---

/**
 * @description Root endpoint.
 */
app.get("/", (req, res) => {
  res.send("✅ VERCEL DEPLOYMENT SUCCESSFUL - CORS FIX IS LIVE!");
});

/**
 * @description Health check endpoint.
 */
app.get("/api/ping", (req, res) => {
  res.send("Server running fine ✅");
});

/**
 * @description [SECURE] Gets a Google Auth URL for the *specific user*
 * who is making the request. This is called by your App.js.
 */
app.get("/api/get-auth-url", verifyFirebaseToken, (req, res) => {
  const scopes = ["https://www.googleapis.com/auth/calendar"];
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes,
    state: req.uid, // ✅ 3. FIX: Pass the user's Firebase UID as the 'state'
  });
  res.json({ authUrl: url });
});

/**
 * @description Handle Google callback after user grants permission.
 */
app.get("/api/callback", async (req, res) => {
  const code = req.query.code;
  const uid = req.query.state; // ✅ 4. FIX: Get the UID back from the 'state'

  if (!code) return res.status(400).send("Missing code.");
  if (!uid) return res.status(400).send("Missing user state.");

  try {
    // Get tokens from Google
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get the user's Google email to display in the frontend
    const people = google.people({ version: "v1", auth: oauth2Client });
    const profile = await people.people.get({
      resourceName: "people/me",
      personFields: "emailAddresses",
    });
    const userEmail = profile.data.emailAddresses?.[0]?.value || "Google User";

    // ✅ 5. FIX: Save tokens to the *correct* path App.js expects
    const integrationRef = db
      .doc(`users/${uid}/settings/integrations`);

    await integrationRef.set({
      googleCalendar: { // <-- Save under the 'googleCalendar' map
        email: userEmail,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expiry_date: tokens.expiry_date,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
      }
    }, { merge: true }); // Use {merge: true} to not overwrite other integrations

    // Redirect user back to the app's settings page
    res.redirect("http://localhost:3000/settings?google-connected=true");
  
  } catch (err) {
    console.error("Error in /api/callback:", err.message);
    res.status(500).send("Error connecting Google account.");
  }
});

/**
 * @description [AUTOMATIC] Syncs a single user's tasks to their Google Calendar.
 * This is called by the /api/sync-all-users cron job.
 */
app.post("/api/sync-calendar", async (req, res) => {
  const { uid } = req.body;
  if (!uid) return res.status(400).send("No user ID provided.");

  try {
    // 1. Get the user's secret tokens from the correct path
    const tokenDoc = await db.doc(`users/${uid}/settings/integrations`).get();
    if (!tokenDoc.exists || !tokenDoc.data().googleCalendar) {
      return res.status(404).send("User has not connected Google Calendar.");
    }
    const tokens = tokenDoc.data().googleCalendar;
    oauth2Client.setCredentials(tokens);

    // 2. Get the user's tasks from Firestore
    const tasksDoc = await db.doc(`users/${uid}/data/tasks`).get();
    if (!tasksDoc.exists) {
      return res.status(200).send("No tasks to sync.");
    }
    
    const allTasks = tasksDoc.data().list || [];
    const tasksToSync = allTasks.filter(
      (task) => task.startTime && task.endTime && !task.completed
    );

    // 3. Initialize the Google Calendar API
    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    // 4. Loop and create events
    let syncedCount = 0;
    for (const task of tasksToSync) {
      // Create a Google-friendly event ID from the task ID
      const eventId = `momentum${task.id.replace(/[^a-zA-Z0-9]/g, "")}`;
      
      const event = {
        summary: task.text,
        description: `Synced from Momentum: ${task.category || "Normal"} Task`,
        start: {
          dateTime: new Date(`${task.dueDate}T${task.startTime}`).toISOString(),
          timeZone: "Asia/Kolkata", // Your timezone
        },
        end: {
          dateTime: new Date(`${task.dueDate}T${task.endTime}`).toISOString(),
          timeZone: "Asia/Kolkata",
        },
        id: eventId,
      };

      try {
        // Use 'insert' which will fail if the ID exists.
        // This prevents creating duplicate events every hour.
        await calendar.events.insert({
          calendarId: "primary",
          resource: event,
        });
        syncedCount++;
      } catch (e) {
        if (e.code === 409) {
          // Event already exists, which is fine. We can just ignore it.
          // In a more advanced app, you might update it here.
        } else {
          console.error(`Error syncing task ${task.id}:`, e.message);
        }
      }
    }
    res.status(200).send(`Sync complete for ${uid}. ${syncedCount} new events created.`);

  } catch (error) {
    console.error(`Sync failed for ${uid}:`, error.message);
    res.status(500).send("Sync failed.");
  }
});

/**
 * @description [AUTOMATIC] Trigger for the Vercel Cron Job.
 * This finds all users with a Google connection and triggers their sync.
 */
app.get("/api/sync-all-users", async (req, res) => {
  // 1. Secure the endpoint
  if (req.headers["authorization"] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).send("Unauthorized");
  }

  try {
    // 2. Find all 'integrations' documents that have a Google token
    const snapshot = await db.collectionGroup("settings")
                             .where("googleCalendar.access_token", ">", "")
                             .get();
    
    if (snapshot.empty) {
      return res.status(200).send("No users to sync.");
    }

    // 3. Get the parent UID for each document
    const userIds = snapshot.docs.map(doc => doc.ref.parent.parent.id);
    const uniqueUserIds = [...new Set(userIds)];

    console.log(`CRON: Found ${uniqueUserIds.length} users to sync.`);

    // 4. Trigger the sync for each user (Don't wait for them)
    for (const uid of uniqueUserIds) {
      // We call our *other* endpoint. This is a "fan-out" pattern.
      fetch(`${process.env.VERCEL_URL}/api/sync-calendar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid: uid }),
      });
    }

    res.status(200).send(`Sync triggered for ${uniqueUserIds.length} users.`);

  } catch (error) {
    console.error("Cron job failed:", error);
    res.status(500).send("Cron job failed");
  }
});

// ✅ Export for Vercel
export default app;