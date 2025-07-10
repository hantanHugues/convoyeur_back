const axios = require('axios');

// L'URL de l'API de votre serveur backend
const API_URL = 'http://localhost:5000/api/event';

// Les types de déchets possibles
const COLORS = ['green', 'yellow', 'red', 'blue'];

/**
 * Choisit une couleur au hasard et envoie un événement au serveur.
 */
const sendRandomEvent = async () => {
  // Choisir une couleur aléatoire dans le tableau
  const randomColor = COLORS[Math.floor(Math.random() * COLORS.length)];

  try {
    console.log(`-> Envoi de l'événement : ${randomColor}`);
    
    // Envoyer la requête POST au serveur avec la couleur choisie
    const response = await axios.post(API_URL, {
      color: randomColor
    });

    console.log(`<- Réponse du serveur (201 Created): ${JSON.stringify(response.data)}`);
  } catch (error) {
    // Gérer les erreurs (par exemple, si le serveur n'est pas encore démarré)
    if (error.response) {
        console.error(`Erreur: Le serveur a répondu avec le statut ${error.response.status}`);
    } else if (error.request) {
        console.error("Erreur: Aucune réponse du serveur. Le serveur est-il bien lancé sur le port 5000 ?");
    } else {
        console.error('Erreur inattendue:', error.message);
    }
  }
};

// Lancer la simulation : envoie un événement toutes les 2 secondes (2000 ms)
console.log("*** Lancement du simulateur de convoyeur ***");
console.log("Un nouvel événement sera envoyé toutes les 2 secondes.");
console.log("Appuyez sur Ctrl+C pour arrêter.");
console.log("---------------------------------------------------");

setInterval(sendRandomEvent, 2000);
