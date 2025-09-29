import makeWASocket, { DisconnectReason, useMultiFileAuthState, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { players } from './shared/schema.js';
import { eq } from 'drizzle-orm';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool });

const WEAPONS = {
  pistolet: { name: 'Pistolet', damage: { tete: 40, torse: 25, bras: 10, jambes: 15 }, price: 0, range: 10 },
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
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'error' }))
    },
    printQRInTerminal: true,
    logger: pino({ level: 'error' })
  });
  
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      console.log('Scannez ce QR code avec WhatsApp:');
      qrcode.generate(qr, { small: true });
    }
    
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom) 
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
        : true;
      
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === 'open') {
      console.log('✅ Bot WhatsApp connecté avec succès!');
    }
  });
  
  sock.ev.on('creds.update', saveCreds);
  
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;
    
    const from = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const sender = msg.key.participant || from;
    const senderName = msg.pushName || 'Joueur';
    
    console.log(`📨 Message reçu de ${senderName}: ${text}`);
    
    try {
      const player = await getOrCreatePlayer(sender, senderName);
      
      if (player.isDead) {
        return;
      }
      
      await regenerateHealth(sender);
      
      if (text.startsWith('/statut')) {
        const updatedPlayer = await getOrCreatePlayer(sender, senderName);
        const healthBar = createHealthBar(updatedPlayer.health);
        const energyBar = createHealthBar(updatedPlayer.energy);
        const weapon = WEAPONS[updatedPlayer.currentWeapon];
        
        const statusMessage = `╔═══════════════════════╗
║   📊 STATUT JOUEUR    ║
╚═══════════════════════╝

👤 ${updatedPlayer.name}

❤️ VIE: ${healthBar} ${updatedPlayer.health}%
⚡ ÉNERGIE: ${energyBar} ${updatedPlayer.energy}%
💰 ARGENT: ${updatedPlayer.money}$

🔫 ARME ÉQUIPÉE: ${weapon.name}
📦 ARMES: ${updatedPlayer.weapons.join(', ')}

📍 Position: (${updatedPlayer.position.x}, ${updatedPlayer.position.y})
🏢 Lieu: ${updatedPlayer.position.location}

🎯 Kills: ${updatedPlayer.kills} | 💀 Morts: ${updatedPlayer.deaths}`;
        
        await sock.sendMessage(from, { text: statusMessage });
      }
      
      else if (text.startsWith('/tire')) {
        if (!msg.message.extendedTextMessage?.contextInfo?.quotedMessage) {
          await sock.sendMessage(from, { 
            text: '⚠️ Vous devez répondre au message de votre adversaire!\nUsage: /tire [partie]\nParties: tete, torse, bras, jambes' 
          });
          return;
        }
        
        const args = text.split(' ');
        const bodyPart = args[1]?.toLowerCase();
        
        if (!bodyPart || !['tete', 'torse', 'bras', 'jambes'].includes(bodyPart)) {
          await sock.sendMessage(from, { 
            text: '⚠️ Vous devez préciser la partie du corps!\nUsage: /tire [partie]\nParties: tete, torse, bras, jambes' 
          });
          return;
        }
        
        const isGroup = from.endsWith('@g.us');
        
        if (!isGroup) {
          await sock.sendMessage(from, { text: '⚠️ Le combat ne fonctionne que dans les groupes WhatsApp!' });
          return;
        }
        
        const targetId = msg.message.extendedTextMessage.contextInfo.participant;
        
        if (!targetId || targetId === sender) {
          await sock.sendMessage(from, { text: '⚠️ Impossible de tirer sur vous-même!' });
          return;
        }
        
        const [target] = await db.select().from(players).where(eq(players.id, targetId));
        
        if (!target) {
          await sock.sendMessage(from, { text: '⚠️ Joueur cible introuvable!' });
          return;
        }
        
        if (target.isDead) {
          await sock.sendMessage(from, { text: '💀 Ce joueur est déjà mort!' });
          return;
        }
        
        const weapon = WEAPONS[player.currentWeapon];
        const distance = Math.sqrt(
          Math.pow(player.position.x - target.position.x, 2) + 
          Math.pow(player.position.y - target.position.y, 2)
        );
        
        if (distance > weapon.range) {
          await sock.sendMessage(from, { 
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
        
        let resultMessage = `🔫 ${player.name} tire sur ${target.name}!\n\n`;
        resultMessage += `🎯 Partie visée: ${bodyPart.toUpperCase()}\n`;
        resultMessage += `💥 Dégâts: -${damage}%\n`;
        resultMessage += `🛡️ Protection (${target.position.location}): -${coverReduction}%\n`;
        resultMessage += `❤️ Vie restante: ${createHealthBar(newHealth)} ${newHealth}%`;
        
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
          
          resultMessage += `\n\n💀 ${target.name} EST MORT!\n💰 +500$ pour ${player.name}`;
        }
        
        await sock.sendMessage(from, { text: resultMessage });
      }
      
      else if (text.startsWith('/localisation')) {
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
        
        await sock.sendMessage(from, { text: locMessage });
      }
      
      else if (text.startsWith('/deplacer')) {
        const args = text.split(' ');
        const newLocation = args[1]?.toLowerCase();
        
        const locationData = LOCATIONS.find(l => l.name === newLocation);
        
        if (!locationData) {
          await sock.sendMessage(from, { 
            text: '⚠️ Lieu invalide!\nLieux disponibles: ' + LOCATIONS.map(l => l.name).join(', ') 
          });
          return;
        }
        
        if (player.energy < 20) {
          await sock.sendMessage(from, { text: '⚠️ Pas assez d\'énergie pour vous déplacer!' });
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
        
        await sock.sendMessage(from, { 
          text: `🏃 Déplacement vers ${locationData.name}!\n📍 Nouvelle position: (${newX}, ${newY})\n${locationData.description}\n⚡ -20% énergie` 
        });
      }
      
      else if (text.startsWith('/acheter')) {
        const args = text.split(' ');
        const weaponName = args[1]?.toLowerCase();
        
        const weapon = WEAPONS[weaponName];
        
        if (!weapon) {
          await sock.sendMessage(from, { 
            text: '⚠️ Arme invalide!\n\n🔫 ARMES DISPONIBLES:\n' + 
                  Object.entries(WEAPONS).map(([key, w]) => 
                    `• ${w.name}: ${w.price}$ (Portée: ${w.range}m)`
                  ).join('\n')
          });
          return;
        }
        
        if (player.weapons.includes(weaponName)) {
          await sock.sendMessage(from, { text: '⚠️ Vous possédez déjà cette arme!' });
          return;
        }
        
        if (player.money < weapon.price) {
          await sock.sendMessage(from, { 
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
        
        await sock.sendMessage(from, { 
          text: `✅ ${weapon.name} acheté!\n💰 -${weapon.price}$\nUtilisez /equiper ${weaponName} pour l'équiper` 
        });
      }
      
      else if (text.startsWith('/equiper')) {
        const args = text.split(' ');
        const weaponName = args[1]?.toLowerCase();
        
        if (!player.weapons.includes(weaponName)) {
          await sock.sendMessage(from, { 
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
        await sock.sendMessage(from, { 
          text: `✅ ${weapon.name} équipé!\n🎯 Dégâts: Tête ${weapon.damage.tete}%, Torse ${weapon.damage.torse}%, Bras ${weapon.damage.bras}%, Jambes ${weapon.damage.jambes}%` 
        });
      }
      
      else if (text.startsWith('/aide') || text.startsWith('/help')) {
        const helpMessage = `🎮 COMMANDES DU JEU

📊 /statut - Voir vos statistiques
🔫 /tire [partie] - Tirer sur un adversaire (en réponse à son message)
   Parties: tete, torse, bras, jambes
📍 /localisation - Voir votre position
🏃 /deplacer [lieu] - Se déplacer
🛒 /acheter [arme] - Acheter une arme
🎯 /equiper [arme] - Équiper une arme

🗺️ LIEUX DISPONIBLES:
${LOCATIONS.map(l => `• ${l.name}: ${l.description}`).join('\n')}

🔫 ARMES DISPONIBLES:
${Object.entries(WEAPONS).map(([key, w]) => 
  `• ${w.name}: ${w.price}$ (Portée: ${w.range}m)`
).join('\n')}

⚡ La vie se régénère de 10% par minute
💀 Si vous mourrez, vous ne pouvez pas jouer pendant 1 heure`;
        
        await sock.sendMessage(from, { text: helpMessage });
      }
    } catch (error) {
      console.error('Erreur:', error);
      await sock.sendMessage(from, { text: '❌ Une erreur est survenue!' });
    }
  });
  
  return sock;
}

connectToWhatsApp();
