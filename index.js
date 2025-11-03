
import 'dotenv/config';
import makeWASocket, { DisconnectReason, useMultiFileAuthState, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import { players } from './shared/schema.js';
import { eq } from 'drizzle-orm';
import express from 'express';
import http from 'http';
import ws, { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve static files
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server is listening on port ${PORT}`);
});

let currentQR = null;

// Broadcast to all connected clients
function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

wss.on('connection', (ws) => {
  console.log('A new client connected.');
  // If there's an active QR code, send it immediately to the new client
  if (currentQR) {
    ws.send(JSON.stringify({ type: 'qr', qr: currentQR }));
  }
});

const sqlite = new Database('wazone.db');
const db = drizzle(sqlite);

const WEAPONS = {
  pistolet: { name: 'Pistolet', damage: {tete: 40, torse: 25, bras: 10, jambes: 15 }, price: 0, range: 10 },
  fusil: { name: 'Fusil d\'Assaut', damage: { tete: 60, torse: 35, bras: 15, jambes: 20 }, price: 5000, range: 30 },
  sniper: { name: 'Sniper', damage: { tete: 95, torse: 70, bras: 30, jambes: 40 }, price: 15000, range: 100 },
  shotgun: { name: 'Shotgun', damage: { tete: 80, torse: 60, bras: 25, jambes: 35 }, price: 8000, range: 5 },
  mitrailleuse: { name: 'Mitrailleuse', damage: { tete: 50, torse: 30, bras: 12, jambes: 18 }, price: 12000, range: 40 }
};

const LOCATIONS = [
  { name: 'rue', description: 'Rue ouverte - Aucune protection', cover: 0 },
  { name: 'immeuble', description: 'Bâtiment - Protection moyenne', cover: 30 },
  { name: 'bunker', description: 'Bunker - Protection élevée', cover: 60 },
  { name: 'foret', description: 'Forêt - Cachette naturelle', cover: 40 },
  { name: 'toiture', description: 'Toiture - Vue dégagée mais exposé', cover: 20 }
];

function createHealthBar(percentage) {
  const filled = Math.floor(percentage / 10);
  const empty = 10 - filled;
  return '▰'.repeat(filled) + '▱'.repeat(empty);
}

async function getOrCreatePlayer(playerId, playerName) {
  const [existingPlayer] = await db.select().from(players).where(eq(players.id, playerId));

  if (existingPlayer) {
    if (existingPlayer.isDead && existingPlayer.deadUntil && new Date() > existingPlayer.deadUntil) {
      await db.update(players)
        .set({ 
          isDead: false, 
          deadUntil: null, 
          health: 100, 
          energy: 100,
          updatedAt: new Date()
        })
        .where(eq(players.id, playerId));
      return { ...existingPlayer, isDead: false, health: 100, energy: 100 };
    }
    return existingPlayer;
  }

  const [newPlayer] = await db.insert(players).values({
    id: playerId,
    name: playerName,
    health: 100,
    energy: 100,
    money: 1000,
    currentWeapon: 'pistolet',
    weapons: ['pistolet'],
    position: { x: Math.floor(Math.random() * 100), y: Math.floor(Math.random() * 100), location: 'rue' },
    lastRegeneration: new Date()
  }).returning();

  return newPlayer;
}

async function regenerateHealth(playerId) {
  const [player] = await db.select().from(players).where(eq(players.id, playerId));

  if (!player || player.isDead || player.health >= 100) return;

  const now = new Date();
  const timeDiff = now - new Date(player.lastRegeneration);
  const minutesPassed = Math.floor(timeDiff / 60000);

  if (minutesPassed >= 1) {
    const regenAmount = minutesPassed * 10;
    const newHealth = Math.min(100, player.health + regenAmount);

    await db.update(players)
      .set({ 
        health: newHealth, 
        lastRegeneration: now,
        updatedAt: now
      })
      .where(eq(players.id, playerId));
  }
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'debug' }))
    },
    printQRInTerminal: false, // We'll handle QR display ourselves
    logger: pino({ level: 'debug' })
  });

  // Fonction pour envoyer un message avec retry et meilleure gestion des groupes
  const sendMessageWithRetry = async (chatId, messageContent, retries = 3) => {
    console.log(`🚀 Tentative d'envoi vers ${chatId}`);
    
    for (let i = 0; i < retries; i++) {
      try {
        // Vérifier si c'est un groupe et si on a les permissions
        if (chatId.endsWith('@g.us')) {
          try {
            const groupMetadata = await sock.groupMetadata(chatId);
            console.log(`👥 Groupe: ${groupMetadata.subject}`);
            console.log(`🔐 Participants: ${groupMetadata.participants.length}`);
            
            // Vérifier si le bot est dans le groupe
            const botUser = sock.user;
            if (!botUser) {
              console.log(`❌ Impossible de récupérer les infos du bot`);
              throw new Error('Infos du bot introuvables');
            }

            console.log(`🔍 Bot user info:`, botUser);

            // Essayer différents formats d'ID pour trouver le bot
            const possibleBotIds = [
              botUser.id,
              botUser.lid, // Format @lid
              botUser.id.split(':')[0] + '@s.whatsapp.net',
              botUser.id.split('@')[0] + '@s.whatsapp.net'
            ].filter(Boolean); // Enlever les valeurs undefined

            console.log(`🔍 IDs possibles du bot:`, possibleBotIds);

            let botParticipant = null;
            for (const id of possibleBotIds) {
              botParticipant = groupMetadata.participants.find(p => p.id === id);
              if (botParticipant) {
                console.log(`✅ Bot trouvé avec l'ID: ${id}`);
                break;
              }
            }
            
            if (!botParticipant) {
              console.log(`❌ Bot pas dans le groupe ${groupMetadata.subject}`);
              console.log(`🔍 IDs testés:`, possibleBotIds);
              console.log(`👥 Participants du groupe:`, groupMetadata.participants.map(p => p.id));
              
              // Essayer de continuer l'envoi quand même car parfois la détection échoue
              console.log(`🔄 Tentative d'envoi malgré la détection échouée...`);
            }
            
            console.log(`🤖 Bot status dans le groupe: ${botParticipant.admin || 'member'}`);
          } catch (metaError) {
            console.error(`⚠️ Erreur métadonnées du groupe:`, metaError.message);
            // Si on n'arrive pas à récupérer les métadonnées, c'est probablement un problème de permissions
            throw new Error(`Impossible d'accéder aux métadonnées du groupe: ${metaError.message}`);
          }
        }
        
        const result = await sock.sendMessage(chatId, messageContent);
        console.log(`✅ Message envoyé avec succès (tentative ${i + 1})`);
        console.log(`📝 Contenu envoyé:`, messageContent.text?.substring(0, 50) + '...');
        return result;
      } catch (error) {
        console.error(`❌ Erreur envoi tentative ${i + 1}:`, error.message);
        console.error(`🔍 Détails erreur:`, error);
        if (i === retries - 1) {
          console.error(`💥 Échec définitif après ${retries} tentatives`);
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
      }
    }
  };

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('QR code received, generating data URL...');
      try {
        const qrCodeUrl = await qrcode.toDataURL(qr);
        currentQR = qrCodeUrl; // Store the latest QR code
        broadcast({ type: 'qr', qr: qrCodeUrl });
        console.log('QR code sent to web client.');
      } catch (err) {
        console.error('Failed to generate QR code', err);
      }
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
        : true;

      broadcast({ type: 'status', message: `Connection closed. Reconnecting: ${shouldReconnect}` });
      console.log(`Connection closed due to ${lastDisconnect?.error}, reconnecting: ${shouldReconnect}`);

      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === 'open') {
      console.log('✅ Bot WhatsApp connected successfully!');
      currentQR = null; // Clear the QR code once connected
      broadcast({ type: 'status', message: 'WhatsApp bot connected successfully!' });
    } else if (connection === 'connecting') {
        console.log('Connecting to WhatsApp...');
        broadcast({ type: 'status', message: 'Connecting to WhatsApp...' });
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const isGroup = from.endsWith('@g.us');
    
    // Extraction du texte depuis différents types de messages
    let text = '';
    if (msg.message.conversation) {
      text = msg.message.conversation;
    } else if (msg.message.extendedTextMessage?.text) {
      text = msg.message.extendedTextMessage.text;
    } else if (msg.message.imageMessage?.caption) {
      text = msg.message.imageMessage.caption;
    } else if (msg.message.videoMessage?.caption) {
      text = msg.message.videoMessage.caption;
    }

    const sender = msg.key.participant || from;
    const senderName = msg.pushName || msg.key.participant?.split('@')[0] || 'Joueur';

    console.log(`📨 Message reçu de ${senderName}: "${text}"`);
    console.log(`🔍 Type de chat: ${isGroup ? 'Groupe' : 'Privé'}`);
    console.log(`👤 Sender ID: ${sender}`);
    console.log(`🆔 Chat ID: ${from}`);

    // Vérifier si c'est une commande
    if (!text.startsWith('/')) {
      console.log(`💬 Message non-commande ignoré: "${text}"`);
      return;
    }

    try {
      console.log(`🔄 Traitement de la commande: "${text}"`);
      
      const player = await getOrCreatePlayer(sender, senderName);
      console.log(`🎮 Joueur chargé: ${player.name} (ID: ${player.id})`);

      if (player.isDead) {
        console.log(`💀 Joueur ${player.name} est mort jusqu'à ${player.deadUntil}`);
        const remainingTime = Math.ceil((new Date(player.deadUntil) - new Date()) / 60000);
        if (remainingTime > 0) {
          await sendMessageWithRetry(from, { 
            text: `💀 Vous êtes mort ! Réapparition dans ${remainingTime} minutes.` 
          });
        }
        return;
      }

      await regenerateHealth(sender);

      if (text.startsWith('/statut')) {
        const updatedPlayer = await getOrCreatePlayer(sender, senderName);
        const healthBar = createHealthBar(updatedPlayer.health);
        const energyBar = createHealthBar(updatedPlayer.energy);
        const weapon = WEAPONS[updatedPlayer.currentWeapon];

        const statusMessage = `@${sender.split('@')[0]} Salut ${updatedPlayer.name} ! 😊

Voici ton état actuel :

❤️ VIE: ${healthBar} ${updatedPlayer.health}%
⚡ ÉNERGIE: ${energyBar} ${updatedPlayer.energy}%
💰 ARGENT: ${updatedPlayer.money}$

🔫 Tu as ton ${weapon.name} en main
📦 Tes armes: ${updatedPlayer.weapons.join(', ')}

📍 Tu es à (${updatedPlayer.position.x}, ${updatedPlayer.position.y}) dans ${updatedPlayer.position.location}

🎯 Kills: ${updatedPlayer.kills} | 💀 Morts: ${updatedPlayer.deaths}`;

        await sendMessageWithRetry(from, { 
          text: statusMessage,
          mentions: [sender]
        });
      }
      
      else if (text.startsWith('/tire')) {
        console.log(`🔫 Commande tir reçue de ${senderName}`);
        if (!msg.message.extendedTextMessage?.contextInfo?.quotedMessage) {
          await sendMessageWithRetry(from, { 
            text: 'Hé ! Tu dois répondre au message de ton adversaire pour le viser 🎯\n\nÉcris par exemple: /tire tete\n(tete, torse, bras, jambes)' 
          });
          return;
        }

        const args = text.split(' ');
        const bodyPart = args[1]?.toLowerCase();

        if (!bodyPart || !['tete', 'torse', 'bras', 'jambes'].includes(bodyPart)) {
          await sendMessageWithRetry(from, { 
            text: '⚠️ Vous devez préciser la partie du corps!\nUsage: /tire [partie]\nParties: tete, torse, bras, jambes' 
          });
          return;
        }

        if (!isGroup) {
          await sendMessageWithRetry(from, { text: '⚠️ Le combat ne fonctionne que dans les groupes WhatsApp!' });
          return;
        }

        const targetId = msg.message.extendedTextMessage.contextInfo.participant;

        if (!targetId || targetId === sender) {
          await sendMessageWithRetry(from, { text: '⚠️ Impossible de tirer sur vous-même!' });
          return;
        }

        const [target] = await db.select().from(players).where(eq(players.id, targetId));

        if (!target) {
          await sendMessageWithRetry(from, { text: '⚠️ Joueur cible introuvable!' });
          return;
        }

        if (target.isDead) {
          await sendMessageWithRetry(from, { text: '💀 Ce joueur est déjà mort!' });
          return;
        }

        const weapon = WEAPONS[player.currentWeapon];
        const distance = Math.sqrt(
          Math.pow(player.position.x - target.position.x, 2) + 
          Math.pow(player.position.y - target.position.y, 2)
        );

        if (distance > weapon.range) {
          await sendMessageWithRetry(from, { 
            text: `⚠️ Cible hors de portée! (Distance: ${Math.floor(distance)}m, Portée: ${weapon.range}m)` 
          });
          return;
        }

        const locationData = LOCATIONS.find(l => l.name === target.position.location);
        const coverReduction = locationData ? locationData.cover : 0;

        let damage = weapon.damage[bodyPart];
        damage = Math.floor(damage * (1 - coverReduction / 100));

        const newHealth = Math.max(0, target.health - damage);

        await db.update(players)
          .set({ 
            health: newHealth,
            updatedAt: new Date()
          })
          .where(eq(players.id, targetId));

        let resultMessage = `🔫 ${player.name} vise et tire sur ${target.name} !\n\n`;
        resultMessage += `🎯 Cible: ${bodyPart.toUpperCase()}\n`;
        resultMessage += `💥 BAM ! -${damage}% de vie\n`;
        resultMessage += `🛡️ Couvert par ${target.position.location} (-${coverReduction}%)\n`;
        resultMessage += `❤️ ${target.name}: ${createHealthBar(newHealth)} ${newHealth}%`;

        if (newHealth <= 0) {
          await db.update(players)
            .set({ 
              isDead: true,
              deadUntil: new Date(Date.now() + 3600000),
              deaths: target.deaths + 1,
              updatedAt: new Date()
            })
            .where(eq(players.id, targetId));

          await db.update(players)
            .set({ 
              kills: player.kills + 1,
              money: player.money + 500,
              updatedAt: new Date()
            })
            .where(eq(players.id, sender));

          resultMessage += `\n\n💀 ${target.name} s'effondre... Il est mort !\n💰 ${player.name} récupère 500$ sur le corps 💸`;
        }

        await sendMessageWithRetry(from, { text: resultMessage });
      }

      else if (text.startsWith('/localisation')) {
        console.log(`📍 Commande localisation reçue de ${senderName}`);
        const locationData = LOCATIONS.find(l => l.name === player.position.location);
        const nearbyLocations = LOCATIONS.filter(l => l.name !== player.position.location)
          .slice(0, 3)
          .map(l => `• ${l.name}: ${l.description}`)
          .join('\n');

        const locMessage = `📍 LOCALISATION

Votre position: (${player.position.x}, ${player.position.y})
🏢 ${locationData.name.toUpperCase()}: ${locationData.description}
🛡️ Protection: ${locationData.cover}%

🗺️ Lieux à proximité:
${nearbyLocations}

Utilisez /deplacer [lieu] pour vous déplacer`;

        await sendMessageWithRetry(from, { text: locMessage });
      }

      else if (text.startsWith('/deplacer')) {
        console.log(`🏃 Commande déplacement reçue de ${senderName}`);
        const args = text.split(' ');
        const newLocation = args[1]?.toLowerCase();

        const locationData = LOCATIONS.find(l => l.name === newLocation);

        if (!locationData) {
          await sendMessageWithRetry(from, { 
            text: '⚠️ Lieu invalide!\nLieux disponibles: ' + LOCATIONS.map(l => l.name).join(', ') 
          });
          return;
        }

        if (player.energy < 20) {
          await sendMessageWithRetry(from, { text: '⚠️ Pas assez d\'énergie pour vous déplacer!' });
          return;
        }

        const newX = Math.floor(Math.random() * 100);
        const newY = Math.floor(Math.random() * 100);

        await db.update(players)
          .set({ 
            position: { x: newX, y: newY, location: newLocation },
            energy: player.energy - 20,
            updatedAt: new Date()
          })
          .where(eq(players.id, sender));

        await sendMessageWithRetry(from, { 
          text: `🏃 Déplacement vers ${locationData.name}!\n📍 Nouvelle position: (${newX}, ${newY})\n${locationData.description}\n⚡ -20% énergie` 
        });
      }

      else if (text.startsWith('/ia')) {
        const userPrompt = text.substring(4).trim();
        if (!userPrompt) {
          await sendMessageWithRetry(from, { text: '🤖 Veuillez donner un ordre à l\'IA. Exemple: /ia va dans un endroit sûr' });
          return;
        }

        await sendMessageWithRetry(from, { text: '🧠 L\'IA réfléchit à votre ordre...' });

        const locationNames = LOCATIONS.map(l => l.name).join(', ');
        const systemPrompt = `Tu es une IA tactique dans un jeu de guerre. Un joueur te donne un ordre de déplacement. Ta seule tâche est de choisir le lieu le plus approprié parmi les options suivantes : ${locationNames}. Réponds avec UN SEUL mot : le nom du lieu.`;

        try {
          const aiLocation = await getAiChoice(userPrompt, systemPrompt);
          const locationData = LOCATIONS.find(l => l.name === aiLocation);

          if (!locationData) {
            await sendMessageWithRetry(from, { text: `🤖 L'IA a suggéré un lieu invalide : ${aiLocation}` });
            return;
          }

          if (player.energy < 20) {
            await sendMessageWithRetry(from, { text: '⚠️ Pas assez d\'énergie pour vous déplacer!' });
            return;
          }

          const newX = Math.floor(Math.random() * 100);
          const newY = Math.floor(Math.random() * 100);

          await db.update(players)
            .set({
              position: { x: newX, y: newY, location: aiLocation },
              energy: player.energy - 20,
              updatedAt: Date.now()
            })
            .where(eq(players.id, sender));

          await sendMessageWithRetry(from, {
            text: `🤖 Sur ordre de l'IA, vous vous déplacez vers ${locationData.name}!\n📍 Nouvelle position: (${newX}, ${newY})\n${locationData.description}\n⚡ -20% énergie`
          });

        } catch (error) {
          console.error("Erreur de l'IA:", error);
          await sendMessageWithRetry(from, { text: '🤖 L\'IA a rencontré une erreur. Veuillez réessayer.' });
        }
      }

      else if (text.startsWith('/acheter')) {
        console.log(`🛒 Commande achat reçue de ${senderName}`);
        const args = text.split(' ');
        const weaponName = args[1]?.toLowerCase();

        const weapon = WEAPONS[weaponName];

        if (!weapon) {
          await sendMessageWithRetry(from, { 
            text: '⚠️ Arme invalide!\n\n🔫 ARMES DISPONIBLES:\n' + 
                  Object.entries(WEAPONS).map(([key, w]) => 
                    `• ${w.name}: ${w.price}$ (Portée: ${w.range}m)`
                  ).join('\n')
          });
          return;
        }

        if (player.weapons.includes(weaponName)) {
          await sendMessageWithRetry(from, { text: '⚠️ Vous possédez déjà cette arme!' });
          return;
        }

        if (player.money < weapon.price) {
          await sendMessageWithRetry(from, { 
            text: `⚠️ Pas assez d'argent! (${player.money}$ / ${weapon.price}$)` 
          });
          return;
        }

        const newWeapons = [...player.weapons, weaponName];

        await db.update(players)
          .set({ 
            weapons: newWeapons,
            money: player.money - weapon.price,
            updatedAt: new Date()
          })
          .where(eq(players.id, sender));

        await sendMessageWithRetry(from, { 
          text: `✅ ${weapon.name} acheté!\n💰 -${weapon.price}$\nUtilisez /equiper ${weaponName} pour l'équiper` 
        });
      }

      else if (text.startsWith('/equiper')) {
        console.log(`🎯 Commande équipement reçue de ${senderName}`);
        const args = text.split(' ');
        const weaponName = args[1]?.toLowerCase();

        if (!player.weapons.includes(weaponName)) {
          await sendMessageWithRetry(from, { 
            text: '⚠️ Vous ne possédez pas cette arme!\nVos armes: ' + player.weapons.join(', ') 
          });
          return;
        }

        await db.update(players)
          .set({ 
            currentWeapon: weaponName,
            updatedAt: new Date()
          })
          .where(eq(players.id, sender));

        const weapon = WEAPONS[weaponName];
        await sendMessageWithRetry(from, { 
          text: `✅ ${weapon.name} équipé!\n🎯 Dégâts: Tête ${weapon.damage.tete}%, Torse ${weapon.damage.torse}%, Bras ${weapon.damage.bras}%, Jambes ${weapon.damage.jambes}%` 
        });
      }

      else if (text === '/test') {
        await sendMessageWithRetry(from, { 
          text: `@${sender.split('@')[0]} ✅ TEST RÉUSSI ! Le bot fonctionne bien ! 🤖`,
          mentions: [sender]
        });
      }
      
      else if (text.startsWith('/aide') || text.startsWith('/help')) {
        const helpMessage = `@${sender.split('@')[0]} Salut ${senderName} ! 😄 Je suis ton bot de combat !

Voici ce que tu peux faire :

📊 /statut - Voir ton état
🔫 /tire [partie] - Attaquer quelqu'un (réponds à son message d'abord !)
📍 /localisation - Où tu es actuellement  
🏃 /deplacer [lieu] - Bouger vers un autre endroit
🛒 /acheter [arme] - Acheter une nouvelle arme
🎯 /equiper [arme] - Changer d'arme

🗺️ Endroits où aller :
${LOCATIONS.map(l => `• ${l.name}: ${l.description}`).join('\n')}

🔫 Armes dispo :
${Object.entries(WEAPONS).map(([key, w]) => 
  `• ${w.name}: ${w.price}$ (${w.range}m de portée)`
).join('\n')}

💡 Tips : Ta vie remonte de 10% chaque minute !
💀 Si tu meurs, tu attends 1h avant de revenir 😅`;

        await sendMessageWithRetry(from, { 
          text: helpMessage,
          mentions: [sender]
        });
      }
      
      else if (text.startsWith('/')) {
        console.log(`❓ Commande inconnue reçue: ${text}`);
        await sendMessageWithRetry(from, { 
          text: `❌ Commande inconnue: ${text}\nUtilisez /aide pour voir les commandes disponibles.` 
        });
      }
      
    } catch (error) {
      console.error('❌ Erreur détaillée:', error);
      console.error('📍 Contexte - From:', from, 'Sender:', sender, 'Text:', text);
      try {
        await sendMessageWithRetry(from, { text: '❌ Une erreur est survenue!' });
      } catch (sendError) {
        console.error('💥 Impossible d\'envoyer le message d\'erreur:', sendError);
      }
    }
  });

  return sock;
}

// Régénération automatique toutes les minutes
setInterval(async () => {
  try {
    const allPlayers = await db.select().from(players);
    for (const player of allPlayers) {
      if (!player.isDead) {
        await regenerateHealth(player.id);
      }
    }
  } catch (error) {
    console.error('Erreur lors de la régénération automatique:', error);
  }
}, 60000); // 60 secondes

async function getAiChoice(prompt, systemPrompt) {
  const url = "https://text.pollinations.ai";
  const data = {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt }
    ],
    model: "openai",
    seed: Math.floor(Math.random() * 1000000),
    jsonMode: false,
    private: true,
    stream: false
  };

  try {
    const response = await axios.post(url, data);
    // L'API de Pollinations peut retourner une chaîne de texte, nous prenons la première ligne
    // et nous enlevons les caractères superflus.
    return response.data.trim().split('\n')[0].toLowerCase().replace(/[^a-z]/g, '');
  } catch (error) {
    console.error("Erreur lors de l'appel à l'API de Pollinations:", error.response ? error.response.data : error.message);
    throw error;
  }
}

connectToWhatsApp();
