const axios = require('axios');

const SERVER_URL = 'http://localhost:5000';
const COLORS = ['green', 'yellow', 'red', 'blue'];

// Fonction pour obtenir un élément aléatoire d'un tableau
const getRandomElement = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Fonction pour obtenir un intervalle de temps aléatoire
const getRandomInterval = () => {
    // Retourne un délai fixe de 4 secondes (4000 ms) comme demandé.
    return 4000;
}

let simulationInterval;

const simulateWasteDetection = async () => {
    const color = getRandomElement(COLORS);
    try {
        // Utilisation de l'endpoint de test pour simuler un événement
        await axios.get(`${SERVER_URL}/api/test-increment/${color}`);
        console.log(`✅  Simulation : Détection d'un déchet [${color.toUpperCase()}] envoyée au serveur.`);
    } catch (error) {
        if (error.code === 'ECONNREFUSED') {
            console.error('❌  Erreur de simulation : Impossible de se connecter au serveur. Est-il démarré sur le port 5000 ?');
            // Arrête la simulation si le serveur n'est pas joignable
            clearInterval(simulationInterval);
        } else {
            console.error(`❌  Erreur lors de la simulation pour [${color}]:`, error.message);
        }
    }
    // Réinitialise l'intervalle pour le prochain événement, créant un rythme plus naturel
    clearInterval(simulationInterval);
    simulationInterval = setInterval(simulateWasteDetection, getRandomInterval());
};

console.log("🚀 Démarrage de la simulation de détection de déchets...");
console.log("   Le script enverra un événement de couleur aléatoire toutes les 4 secondes.");
console.log("   Assurez-vous que votre serveur principal (node index.js) est en cours d'exécution.");
console.log("   Appuyez sur CTRL+C pour arrêter.");

// Démarre la première simulation
simulationInterval = setInterval(simulateWasteDetection, getRandomInterval());
