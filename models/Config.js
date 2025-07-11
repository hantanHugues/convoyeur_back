const mongoose = require('mongoose');

// Ce schéma stockera les configurations modifiables depuis l'interface admin.
// Il n'y aura qu'un seul document dans cette collection.
const ConfigSchema = new mongoose.Schema({
    // Clé API pour le service Google Gemini
    geminiApiKey: {
        type: String,
    },

    // Hash du mot de passe admin pour une comparaison sécurisée
    adminPasswordHash: {
        type: String
    }
});

// Méthode statique pour obtenir la configuration unique
// Crée la configuration avec les valeurs du .env si elle n'existe pas
ConfigSchema.statics.getSingleton = async function() {
    let config = await this.findOne();
    if (!config) {
        config = new this({});
        await config.save();
    }
    return config;
};

module.exports = mongoose.model('Config', ConfigSchema);
