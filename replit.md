# Bot WhatsApp - Jeu de Combat

## Aperçu du Projet
Bot WhatsApp de jeu de combat développé avec Baileys. Les joueurs s'affrontent dans un environnement interactif avec système de vie, armes variées, positions tactiques et mécanismes de régénération.

## État Actuel
- ✅ Bot WhatsApp fonctionnel avec connexion Baileys
- ✅ Base de données PostgreSQL configurée avec Drizzle ORM
- ✅ Système de joueurs complet avec statistiques persistantes
- ✅ Toutes les commandes de jeu implémentées

## Architecture

### Technologies
- **Backend**: Node.js (ES Modules)
- **WhatsApp API**: @whiskeysockets/baileys v7.0.0
- **Base de données**: PostgreSQL (Neon) via Drizzle ORM
- **Logging**: Pino
- **QR Code**: qrcode-terminal

### Structure des Fichiers
```
workspace/
├── index.js              # Bot WhatsApp principal
├── shared/
│   └── schema.js         # Schéma de base de données (table players)
├── server/
│   └── db.ts            # Configuration de connexion à la base de données
├── drizzle.config.ts    # Configuration Drizzle
├── auth_info_baileys/   # Session WhatsApp (auto-généré)
└── package.json         # Dépendances et scripts
```

### Base de Données
Table `players` avec colonnes:
- `id` (text): ID WhatsApp du joueur (clé primaire)
- `name` (text): Nom du joueur
- `health` (integer): Points de vie (0-100)
- `energy` (integer): Points d'énergie (0-100)
- `money` (integer): Argent virtuel pour acheter des armes
- `currentWeapon` (text): Arme équipée actuellement
- `weapons` (jsonb): Liste des armes possédées
- `position` (jsonb): Position x, y et lieu actuel
- `isDead` (boolean): État de mort du joueur
- `deadUntil` (timestamp): Date de réapparition
- `lastRegeneration` (timestamp): Dernière régénération de vie
- `kills`, `deaths` (integer): Statistiques de combat
- `createdAt`, `updatedAt` (timestamp): Métadonnées

## Fonctionnalités du Jeu

### Système de Combat
- **Barres visuelles**: Utilise ▰ pour rempli, ▱ pour vide
- **Régénération**: +10% de vie par minute automatiquement
- **Ciblage**: Tête (-40%), Torse (-25%), Bras (-10%), Jambes (-15%)
- **Distance**: Vérification de la portée de l'arme
- **Protection**: Réduction des dégâts selon le lieu (rue 0%, bunker 60%)

### Armes Disponibles
1. **Pistolet** (gratuit) - Portée: 10m
2. **Fusil d'Assaut** (5000$) - Portée: 30m
3. **Sniper** (15000$) - Portée: 100m
4. **Shotgun** (8000$) - Portée: 5m
5. **Mitrailleuse** (12000$) - Portée: 40m

### Lieux
- **Rue**: Aucune protection (0%)
- **Immeuble**: Protection moyenne (30%)
- **Bunker**: Protection élevée (60%)
- **Forêt**: Cachette naturelle (40%)
- **Toiture**: Vue dégagée mais exposé (20%)

### Commandes
- `/statut` - Affiche santé, énergie, armes, position, statistiques
- `/tire [partie]` - Tire sur un adversaire (en réponse à son message)
- `/localisation` - Affiche position et lieux à proximité
- `/deplacer [lieu]` - Change de position (-20% énergie)
- `/acheter [arme]` - Achète une nouvelle arme
- `/equiper [arme]` - Équipe une arme possédée
- `/aide` ou `/help` - Liste des commandes

### Mécanisme de Mort
- Joueur mort ne peut plus jouer pendant 1 heure
- Messages automatiquement supprimés pendant cette période
- Réapparition automatique avec vie et énergie pleines
- Récompense au tueur: +500$ + 1 kill

## Utilisation

### Démarrage
1. Lancer le bot: `npm start`
2. Scanner le QR code avec WhatsApp
3. Le bot se connecte et écoute les messages

### Configuration
- Variables d'environnement PostgreSQL automatiquement configurées
- Session WhatsApp sauvegardée dans `auth_info_baileys/`
- Pas de configuration manuelle requise

### Scripts NPM
- `npm start` - Lance le bot
- `npm run db:push` - Synchronise le schéma avec la base de données

## Notes Techniques

### Gestion de Session
- Utilise `useMultiFileAuthState` pour persistance
- Reconnexion automatique en cas de déconnexion
- QR code affiché au démarrage si non connecté

### Sécurité
- Jamais de secrets en dur dans le code
- Variables d'environnement pour DATABASE_URL
- Validation des entrées utilisateur

### Performance
- Base de données PostgreSQL pour persistance
- Queries optimisées avec Drizzle ORM
- Régénération calculée à la demande (pas de cron jobs)

## Améliorations Futures Possibles
- Ajout de centaines d'armes supplémentaires
- Système de durabilité et rechargement des armes
- Carte de jeu plus complexe avec zones dangereuses
- Système de squad/équipe
- Missions quotidiennes et récompenses
- Classement des meilleurs joueurs
- Système d'armures et protections
- Événements spéciaux et boss battles

## Date de Création
29 septembre 2025
