/**
 * Manage developers and agent keys from the command line (developers can also manage their own keys at /portal).
 *
 *   npm run keys -- create <developer> [label]   prints a new key ONCE
 *   npm run keys -- list
 *   npm run keys -- revoke <agent_id>
 *   npm run keys -- dev-create <developer> [max_agents]   invite a developer to the portal, prints the token ONCE
 *   npm run keys -- dev-list
 *   npm run keys -- dev-revoke <developer>                portal access only; use revoke for their agents
 *   npm run keys -- dev-token <developer>                 lost token: prints a new one ONCE, the old one stops working, agents are kept
 *   npm run keys -- backup <file>                         consistent copy of the database (safe while the server runs)
 *
 * Env: VIVARIUM_DB (default data/vivarium.db)
 */
import { Store } from "./store.js";

const [command, ...args] = process.argv.slice(2);
const store = new Store(process.env["VIVARIUM_DB"] ?? "data/vivarium.db");

try {
  switch (command) {
    case "create": {
      const developer = args[0];
      if (!developer) throw new Error("usage: keys create <developer> [label]");
      const { agentId, key } = store.createKey(developer, args[1] ?? "");
      console.log(`agent_id: ${agentId}`);
      console.log(`key:      ${key}`);
      console.log("\nCopy the key now: it is stored only as a hash and cannot be shown again.");
      break;
    }
    case "list": {
      const keys = store.listKeys();
      if (!keys.length) console.log("No keys.");
      for (const k of keys) {
        const state = k.revokedAt ? `revoked ${k.revokedAt.slice(0, 10)}` : "active";
        console.log(`${k.agentId}  ${state.padEnd(18)}  ${k.developer}  ${k.label || "-"}  name=${k.name ?? "(not chosen)"}  last_seen=${k.lastSeen ?? "never"}`);
      }
      break;
    }
    case "revoke": {
      const agentId = args[0];
      if (!agentId) throw new Error("usage: keys revoke <agent_id>");
      console.log(store.revokeKey(agentId) ? `Revoked ${agentId}.` : `No active key for ${agentId}.`);
      break;
    }
    case "dev-create": {
      const name = args[0];
      if (!name) throw new Error("usage: keys dev-create <developer> [max_agents]");
      const { token } = store.createDeveloper(name, args[1] ? Number(args[1]) : 5);
      console.log(`developer: ${name}`);
      console.log(`token:     ${token}`);
      console.log("\nSend this token privately: it opens the portal (/portal) and is stored only as a hash.");
      break;
    }
    case "dev-list": {
      const devs = store.listDevelopers();
      if (!devs.length) console.log("No developers.");
      for (const d of devs) {
        console.log(`${d.name.padEnd(20)} ${d.revokedAt ? "revoked" : "active "}  agents ${store.activeKeyCount(d.name)}/${d.maxAgents}  since ${d.createdAt.slice(0, 10)}`);
      }
      break;
    }
    case "dev-token": {
      const name = args[0];
      if (!name) throw new Error("usage: keys dev-token <developer>");
      const token = store.resetDeveloperToken(name);
      if (!token) throw new Error(`No developer ${name} (see dev-list).`);
      console.log(`developer: ${name}`);
      console.log(`token:     ${token}`);
      console.log("\nThe previous token no longer works. Agents and their keys are unchanged.");
      break;
    }
    case "dev-revoke": {
      const name = args[0];
      if (!name) throw new Error("usage: keys dev-revoke <developer>");
      console.log(store.revokeDeveloper(name) ? `Portal access revoked for ${name}.` : `No active developer ${name}.`);
      break;
    }
    case "backup": {
      const file = args[0];
      if (!file) throw new Error("usage: keys backup <file>");
      store.backup(file);
      console.log(`Database copied to ${file}.`);
      break;
    }
    default:
      console.log("usage: keys create <developer> [label] | list | revoke <agent_id> | dev-create <developer> [max] | dev-list | dev-revoke <developer> | dev-token <developer>");
      process.exitCode = 1;
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  store.close();
}
