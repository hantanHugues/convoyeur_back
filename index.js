require('dotenv').config();
const fetch = require('node-fetch');
global.fetch = fetch;
global.Headers = fetch.Headers;
global.Request = fetch.Request;
global.Response = fetch.Response;
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const { Server } = require("socket.io");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Config = require('./models/Config'); // Notre nouveau modèle de configuration
const { Parser } = require('json2csv');
const PDFDocument = require('pdfkit');
// const { SerialPort } = require('serialport');
// const { ReadlineParser } = require('@serialport/parser-readline');

// --- Configuration Globale de l'Application ---
// Cet objet contiendra la configuration active, chargée depuis .env puis surchargée par la DB.
const appConfig = {
    geminiApiKey: process.env.GEMINI_API_KEY,
    mongoDbUri: process.env.MONGODB_URI,
    adminPassword: process.env.ADMIN_PASSWORD,
    jwtSecret: process.env.JWT_SECRET || 'un-secret-par-defaut-pour-le-dev'
};

// --- Configuration ---
// --- Middleware de vérification de Token JWT ---
const verifyToken = (req, res, next) => {
    const bearerHeader = req.headers['authorization'];
    if (typeof bearerHeader !== 'undefined') {
        const bearerToken = bearerHeader.split(' ')[1];
        jwt.verify(bearerToken, appConfig.jwtSecret, (err, authData) => {
            if (err) {
                return res.sendStatus(403); // Forbidden
            }
            req.authData = authData;
            next();
        });
    } else {
        res.sendStatus(401); // Unauthorized
    }
};

// --- Express App Setup ---
const app = express();
app.use(cors()); // Enable CORS for all routes
app.use(express.json()); // Middleware to parse JSON bodies

const server = http.createServer(app);
const PORT = process.env.PORT || 5000;

// --- API Routes pour l'Administration ---

// Connexion Admin - Logique sécurisée avec bcrypt
app.post('/api/admin/login', async (req, res) => {
    const { password } = req.body;
    if (!password) {
        return res.status(400).json({ message: 'Le mot de passe est requis.' });
    }

    try {
        const config = await Config.getSingleton();
        if (!config.adminPasswordHash) {
            return res.status(500).json({ message: 'Le système n\'est pas encore configuré avec un mot de passe administrateur.' });
        }

        const isMatch = await bcrypt.compare(password, config.adminPasswordHash);

        if (!isMatch) {
            return res.status(401).json({ message: 'Mot de passe incorrect.' });
        }

        jwt.sign({ user: 'admin' }, appConfig.jwtSecret, { expiresIn: '8h' }, (err, token) => {
            if (err) {
                return res.status(500).json({ message: 'Erreur lors de la création du token.' });
            }
            res.json({ token });
        });

    } catch (error) {
        console.error('Erreur lors de la connexion admin:', error);
        res.status(500).json({ message: 'Erreur serveur lors de la connexion.' });
    }
});

// Récupérer la configuration actuelle
app.get('/api/admin/config', verifyToken, async (req, res) => {
    try {
        const config = await Config.getSingleton();
        res.json({
            geminiApiKey: config.geminiApiKey || ''
        });
    } catch (error) {
        res.status(500).json({ message: 'Erreur serveur', error });
    }
});

// Mettre à jour la configuration
// Mettre à jour la configuration
app.post('/api/admin/config', verifyToken, async (req, res) => {
    try {
        const { geminiApiKey } = req.body;
        const config = await Config.getSingleton();

        config.geminiApiKey = geminiApiKey;
        await config.save();

        // Mettre à jour la configuration en mémoire pour Gemini (prise d'effet immédiate)
        appConfig.geminiApiKey = geminiApiKey;
        // Recréer l'instance genAI pour utiliser la nouvelle clé
        if (appConfig.geminiApiKey) {
            genAI = new GoogleGenerativeAI(appConfig.geminiApiKey);
            console.log('Instance Gemini re-initialisée avec la nouvelle clé API.');
        } else {
            genAI = null; // Désactiver si la clé est vide
        }

        res.json({ message: 'Clé API Gemini mise à jour avec succès.' });
    } catch (error) {
        console.error('Erreur sauvegarde config admin:', error);
        res.status(500).json({ message: 'Erreur serveur lors de la sauvegarde.' });
    }
});

// --- Socket.IO Setup ---
const io = new Server(server, {
    cors: {
        origin: "http://localhost:3000", // We'll run the React client on port 3000
        methods: ["GET", "POST"]
    }
});

// --- MongoDB Connection ---


// --- Mongoose Schema and Model for Waste data ---
const WasteSchema = new mongoose.Schema({
    color: {
        type: String,
        required: true,
        enum: ['green', 'yellow', 'red', 'blue']
    },
    count: {
        type: Number,
        default: 0
    }
});

const Waste = mongoose.model('Waste', WasteSchema);

// --- Mongoose Schema and Model for individual events ---
const EventSchema = new mongoose.Schema({
    color: {
        type: String,
        required: true,
        enum: ['green', 'yellow', 'red', 'blue']
    },
    timestamp: {
        type: Date,
        default: Date.now
    }
});

const Event = mongoose.model('Event', EventSchema);

// --- API Routes ---
// Route to get initial waste counts
// Route to receive a new event from the simulator or a physical device
app.post('/api/event', async (req, res) => {
    const { color } = req.body;

    if (!['green', 'yellow', 'red', 'blue'].includes(color)) {
        return res.status(400).json({ message: 'Invalid color provided' });
    }

    try {
        // Increment the total count for the given color
        await Waste.findOneAndUpdate(
            { color: color },
            { $inc: { count: 1 } },
            { new: true, upsert: true } // upsert: true creates the document if it doesn't exist
        );

        // Create a new event log for the timeline
        const newEvent = new Event({ color });
        await newEvent.save();

        // Get the updated counts to send to the client
        const updatedCounts = await Waste.find({});

        // Emit a single, unified event for perfect client-side synchronization
        io.emit('atomic_update', { newEvent, updatedCounts });

        // Send a success response
        res.status(201).json({ message: `Event for ${color} recorded successfully`, event: newEvent });

    } catch (error) {
        console.error('Error recording event:', error);
        res.status(500).json({ message: 'Error recording event', error });
    }
});

// Route to get a paginated list of events for the history page
app.get('/api/events', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    try {
        // Fetch the total number of events to calculate total pages
        const totalEvents = await Event.countDocuments();
        
        // Fetch the paginated events, sorted by most recent
        const events = await Event.find()
            .sort({ timestamp: -1 })
            .skip(skip)
            .limit(limit);

        res.json({
            totalPages: Math.ceil(totalEvents / limit),
            currentPage: page,
            events
        });
    } catch (error) {
        console.error('Error fetching events:', error);
        res.status(500).json({ message: 'Error fetching events', error });
    }
});

app.get('/api/waste-counts', async (req, res) => {
    try {
        let counts = await Waste.find({});
        // If the database is empty, initialize it with all colors
        if (counts.length === 0) {
            const initialData = [
                { color: 'green', count: 0 },
                { color: 'yellow', count: 0 },
                { color: 'red', count: 0 },
                { color: 'blue', count: 0 }
            ];
            await Waste.insertMany(initialData);
            counts = await Waste.find({});
        }
        res.json(counts);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching waste counts', error });
    }
});

// --- TEST ROUTE TO SIMULATE ARDUINO --- 
// This is a temporary route for testing the real-time updates.
// To use, open a browser and go to: http://localhost:5000/api/test-increment/blue (or red, green, yellow)
app.get('/api/test-increment/:color', async (req, res) => {
    const { color } = req.params;

    if (!['green', 'yellow', 'red', 'blue'].includes(color)) {
        return res.status(400).json({ message: 'Invalid color' });
    }

    try {
        const updatedWaste = await Waste.findOneAndUpdate(
            { color: color },
            { $inc: { count: 1 } },
            { new: true, upsert: true }
        );

        const allCounts = await Waste.find({});
        // Create a new event log
        const newEvent = new Event({ color });
        await newEvent.save();

        // 4. Émet UN SEUL événement unifié pour une synchronisation parfaite côté client
        io.emit('atomic_update', { newEvent, updatedCounts: allCounts });

        res.json({ message: `Successfully incremented ${color}`, data: allCounts });

    } catch (error) {
        res.status(500).json({ message: 'Error incrementing waste count', error });
    }
});

// Route to get the last N events for the log
app.get('/api/events', async (req, res) => {
    try {
        const events = await Event.find().sort({ timestamp: -1 }).limit(20);
        res.json(events);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching events', error });
    }
});

// ROUTE POUR RÉINITIALISER LA BASE DE DONNÉES
app.post('/api/reset-database', verifyToken, async (req, res) => {
    try {
        console.log('--- DATABASE RESET TRIGGERED ---');
        await Waste.deleteMany({});
        await Event.deleteMany({});
        console.log('Collections cleared.');

        const initialCounts = [
            { color: 'green', count: 0 },
            { color: 'yellow', count: 0 },
            { color: 'red', count: 0 },
            { color: 'blue', count: 0 }
        ];
        await Waste.insertMany(initialCounts);
        console.log('Initial counts re-inserted.');

        const allCounts = await Waste.find({});
        io.emit('update_counts', allCounts); // Forcer la mise à jour des clients

        // Envoyer un événement vide ou un signal pour vider le journal côté client si nécessaire
        // Pour l'instant, on se contente de vider la DB

        res.status(200).send('La base de données a été réinitialisée avec succès.');

    } catch (error) {
        console.error('Erreur lors de la réinitialisation de la base de données:', error);
        res.status(500).send('Échec de la réinitialisation de la base de données.');
    }
});


// --- Gemini AI API Route ---

// La clé API est maintenant chargée de manière sécurisée depuis le fichier .env
let genAI; // Déclaré avec let pour permettre la réinitialisation

app.post('/api/ask-gemini', async (req, res) => {
    try {
        const { prompt: userPrompt } = req.body;

        if (!userPrompt) {
            return res.status(400).json({ message: 'Prompt is missing.' });
        }



        // 2. Définir le prompt système DIRECTIF
        const systemPrompt = `
Tu es "CogniTri", un assistant IA bienveillant et polyvalent intégré à un tableau de bord de supervision d'un convoyeur de tri de déchets industriel.

Ta mission principale est d'aider l'utilisateur en répondant à ses questions sur les données de tri qui te sont fournies en temps réel. Tu es un expert de ces données et tu dois pouvoir donner des chiffres précis, des pourcentages, et identifier des tendances simples.

Cependant, tu es aussi un assistant généraliste. Si l'utilisateur te pose des questions qui ne sont pas liées aux données, tu peux y répondre de manière serviable et engageante. Garde un ton amical et encourageant.

Ton identité :
- Nom : CogniTri
- Personnalité : Charitable, patient, et un peu enthousiaste. Tu es là pour rendre la journée de l'opérateur plus agréable et productive.
- Rôle : Expert des données de tri ET assistant général.

Quand tu réponds à une question sur les données, sois précis. Si le contexte de données est vide, signale-le simplement à l'utilisateur. Quand c'est une question générale, sois conversationnel.
`;

        // 3. Analyse de la question pour injection de contexte
        const dataKeywords = ['déchet', 'dechet', 'couleur', 'trier', 'nombre', 'combien', 'total', 'statistique', 'rouge', 'vert', 'bleu', 'jaune'];
        const requiresData = dataKeywords.some(keyword => userPrompt.toLowerCase().includes(keyword));

        let fullPrompt;

        if (requiresData) {
            // 1. Récupérer les données en temps réel UNIQUEMENT si nécessaire
            const wasteCounts = await Waste.find({});
            const dataContext = wasteCounts.length > 0 
                ? wasteCounts.map(item => `${item.color}: ${item.count}`).join(', ') 
                : "Aucune donnée de tri n'est disponible pour le moment.";

            // Si la question concerne les données, on les injecte
            fullPrompt = `
CONTEXTE DES DONNÉES DE TRI EN TEMPS RÉEL (à utiliser pour répondre) :
- Décomptes totaux : ${dataContext}

QUESTION DE L'OPÉRATEUR :
${userPrompt}
`;
        } else {
            // Sinon, on envoie la question directement
            fullPrompt = userPrompt;
        }

        // 4. Démarrer le modèle et le chat
                                        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        const chat = model.startChat({
            history: [
                {
                    role: 'user',
                    parts: [{ text: systemPrompt }],
                },
                {
                    role: 'model',
                    parts: [{ text: 'Compris. Je réponds aux questions en me basant uniquement sur les données fournies.' }],
                },
            ],
            generationConfig: {
                maxOutputTokens: 400,
            },
        });

        const result = await chat.sendMessage(fullPrompt);
        const response = await result.response;
        const text = response.text();

        res.json({ response: text });

    } catch (error) {
        console.error('Gemini API Error:', error);
        res.status(500).json({ message: 'Error communicating with AI assistant.' });
    }
});


// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    console.log('A user connected to the dashboard');

    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

// --- Arduino Serial Port Communication (Placeholder) ---
// This section will be configured to match your Arduino's port and baud rate.
// It's commented out to prevent errors until the hardware is ready.
/*
try {
    // Replace '/dev/ttyACM0' with your Arduino's port (e.g., 'COM3' on Windows)
    const port = new SerialPort({ path: '/dev/ttyACM0', baudRate: 9600 });
    const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

    console.log('Attempting to open serial port...');

    port.on('open', () => {
        console.log('Serial Port connection established.');
    });

    parser.on('data', async (data) => {
        const color = data.trim().toLowerCase();
        console.log('Data received from Arduino:', color);

        if (['green', 'yellow', 'red', 'blue'].includes(color)) {
            try {
                // Increment the count for the detected color in the database
                const updatedWaste = await Waste.findOneAndUpdate(
                    { color: color },
                    { $inc: { count: 1 } },
                    { new: true, upsert: true } // 'upsert' creates the document if it doesn't exist
                );

                console.log(`Updated count for ${color}: ${updatedWaste.count}`);

                // Get all current counts and broadcast them to all connected web clients
                const allCounts = await Waste.find({});
                io.emit('update_counts', allCounts);

            } catch (error) {
                console.error('Error updating database from Arduino data:', error);
            }
        }
    });

    port.on('error', (err) => {
        console.error('SerialPort Error: ', err.message);
    });

} catch (error) {
    console.error("Could not connect to Arduino. Please ensure it's connected and the port is correct.");
}
*/

// --- System Settings (in-memory for now) ---
let serverSettings = {
    stoppageThreshold: 2 * 60 * 1000, // 2 minutes default
};

// --- API Route for Settings ---
app.get('/api/settings', (req, res) => {
    res.json(serverSettings);
});

app.post('/api/settings', (req, res) => {
    const { stoppageThreshold } = req.body;

    if (stoppageThreshold && typeof stoppageThreshold === 'number' && stoppageThreshold > 0) {
        // Convert minutes from frontend to milliseconds for backend
        serverSettings.stoppageThreshold = stoppageThreshold * 60 * 1000;
        console.log(`Settings updated: Stoppage threshold set to ${serverSettings.stoppageThreshold}ms`);
        res.status(200).json({ message: 'Settings updated successfully.', settings: serverSettings });
    } else {
        res.status(400).json({ message: 'Invalid settings format.' });
    }
});

// Route pour exporter les données
app.get('/api/export/events', async (req, res) => {
    const { format } = req.query;

    try {
        // Utilisation de .lean() pour de meilleures performances en lecture seule
        const events = await Event.find({}).sort({ timestamp: -1 }).lean();

        if (format === 'csv') {
            const fields = ['color', 'timestamp'];
            const opts = { fields };
            const parser = new Parser(opts);
            const csv = parser.parse(events);
            res.header('Content-Type', 'text/csv');
            res.attachment('export_evenements.csv');
            return res.send(csv);
        } else if (format === 'pdf') {
            // --- Calcul des statistiques ---
            const stats = await Event.aggregate([
                { $group: { _id: '$color', count: { $sum: 1 } } },
                { $sort: { _id: 1 } }
            ]);

            const totalEvents = events.length;
            const firstEventDate = totalEvents > 0 ? new Date(events[events.length - 1].timestamp).toLocaleDateString('fr-FR') : 'N/A';
            const lastEventDate = totalEvents > 0 ? new Date(events[0].timestamp).toLocaleDateString('fr-FR') : 'N/A';

            const colorStats = {};
            stats.forEach(stat => { colorStats[stat._id] = stat.count; });

            const doc = new PDFDocument({ margin: 50, bufferPages: true });
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', 'attachment; filename=Rapport-Evenements.pdf');
            doc.pipe(res);

            // --- Page 1: Statistiques Générales ---
            doc.fontSize(24).font('Helvetica-Bold').text('Rapport d\'Événements de Tri', { align: 'center' });
            doc.moveDown(2);
            doc.fontSize(16).font('Helvetica-Bold').text('Période du rapport :');
            doc.fontSize(12).font('Helvetica').text(`Du ${firstEventDate} au ${lastEventDate}`);
            doc.moveDown();
            doc.fontSize(16).font('Helvetica-Bold').text('Statistiques Générales :');
            doc.fontSize(12).font('Helvetica').text(`Nombre total d'événements : ${totalEvents}`);
            doc.moveDown();
            doc.fontSize(14).font('Helvetica-Bold').text('Répartition par couleur :');
            const colorMap = { green: '#28a745', yellow: '#ffc107', red: '#dc3545', blue: '#007bff' };
            let statY = doc.y;
            for (const [color, name] of Object.entries({ green: 'Vert', yellow: 'Jaune', red: 'Rouge', blue: 'Bleu' })) {
                const count = colorStats[color] || 0;
                const percentage = totalEvents > 0 ? ((count / totalEvents) * 100).toFixed(1) : 0;
                doc.fillColor(colorMap[color]).circle(60, statY + 6, 6).fill();
                doc.fillColor('black').font('Helvetica').fontSize(12).text(`${name}: ${count} (${percentage}%)`, 80, statY);
                statY += 20;
            }
            doc.y = statY;

            // --- Pages suivantes: Historique Détaillé ---
            if (totalEvents > 0) {
                doc.addPage();
                doc.fontSize(20).font('Helvetica-Bold').text('Historique Détaillé des Événements', { align: 'center' });
                doc.moveDown();
                const tableTop = doc.y;
                doc.fontSize(12).font('Helvetica-Bold');
                doc.text('Date et Heure', 50, tableTop);
                doc.text('Couleur Détectée', 450, tableTop);
                doc.moveTo(50, doc.y + 5).lineTo(550, doc.y + 5).stroke();
                doc.y += 15;

                events.forEach(event => {
                    if (doc.y > 720) { doc.addPage(); }
                    const eventDate = new Date(event.timestamp).toLocaleString('fr-FR');
                    const currentY = doc.y;
                    doc.fillColor('black').font('Helvetica').fontSize(10).text(eventDate, 50, currentY, { align: 'left' });
                    doc.fillColor(colorMap[event.color] || 'gray').circle(460, currentY + 6, 5).fill();
                    doc.fillColor('black').text(event.color.charAt(0).toUpperCase() + event.color.slice(1), 475, currentY, { align: 'left' });
                    doc.y += 20;
                });
            }
            doc.end();
        } else { // Par défaut ou si format=json
            res.header('Content-Type', 'application/json');
            res.attachment('export_evenements.json');
            res.json(events);
        }
    } catch (error) {
        console.error("Erreur lors de l'export des données:", error);
        res.status(500).send("Erreur serveur lors de la génération de l'export.");
    }
});

// --- Proactive AI Alert Engine ---

let isStoppageAlertActive = false;

const analyzeAndAlert = async () => {
    try {
        const lastEvent = await Event.findOne().sort({ timestamp: -1 });

        if (lastEvent) {
            const now = new Date();
            const timeSinceLastEvent = now - lastEvent.timestamp;

            if (timeSinceLastEvent > serverSettings.stoppageThreshold && !isStoppageAlertActive) {
                console.log('ALERT: Conveyor stoppage detected!');
                io.emit('new_alert', {
                    id: `stoppage-${Date.now()}`,
                    type: 'warning',
                    message: `Aucune activité détectée depuis plus de ${Math.round(serverSettings.stoppageThreshold / 60000)} minutes. Le convoyeur est peut-être à l'arrêt.`
                });
                isStoppageAlertActive = true;
            } else if (timeSinceLastEvent <= serverSettings.stoppageThreshold && isStoppageAlertActive) {
                console.log('INFO: Conveyor activity resumed.');
                io.emit('new_alert', {
                    id: `resume-${Date.now()}`,
                    type: 'info',
                    message: 'L\'activité du convoyeur a repris normalement.'
                });
                isStoppageAlertActive = false;
            }
        }
    } catch (error) {
        console.error('Error in alert analysis engine:', error);
    }
};

// Run the analysis every 30 seconds
setInterval(analyzeAndAlert, 30000);

// --- Start Server ---
const startServer = async () => {
    try {
        console.log('Connexion à MongoDB...');
        await mongoose.connect(appConfig.mongoDbUri, { useNewUrlParser: true, useUnifiedTopology: true });
        console.log('Connecté avec succès à MongoDB.');

        console.log('Vérification et chargement de la configuration...');
        const config = await Config.getSingleton();

        // Initialisation sécurisée du mot de passe admin au premier démarrage
        if (!config.adminPasswordHash && process.env.ADMIN_PASSWORD) {
            console.log('Initialisation du mot de passe administrateur...');
            const salt = await bcrypt.genSalt(10);
            config.adminPasswordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, salt);
            await config.save();
            console.log('Mot de passe administrateur initialisé et haché avec succès.');
        } else if (!config.adminPasswordHash && !process.env.ADMIN_PASSWORD) {
            console.error('ERREUR: Aucun mot de passe admin n\'est défini dans la DB ou dans le .env. Le login sera impossible.');
        }

        // Chargement de la clé API Gemini
        if (config.geminiApiKey) {
            appConfig.geminiApiKey = config.geminiApiKey;
            console.log('Clé API Gemini chargée depuis la base de données.');
        }

        // Initialiser le client Gemini avec la clé API finale
        if (appConfig.geminiApiKey) {
            genAI = new GoogleGenerativeAI(appConfig.geminiApiKey);
            console.log('Client Google Generative AI initialisé.');
        } else {
            console.warn('ATTENTION: Aucune clé API Gemini n\'est configurée. L\'assistant IA ne fonctionnera pas.');
        }

        server.listen(PORT, () => {
            console.log(`Serveur prêt et à l'écoute sur le port ${PORT}`);
        });

    } catch (error) {
        console.error('ERREUR CRITIQUE AU DÉMARRAGE DU SERVEUR :', error);
        process.exit(1); // Arrête le processus si la connexion DB ou la config échoue
    }
};

// Lancer le serveur
startServer();
