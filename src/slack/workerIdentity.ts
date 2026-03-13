import type { WorkerIdentity, WorkerRecord } from "../types.js";

const WORKER_IDENTITIES: WorkerIdentity[] = [
  { username: "Gear", iconEmoji: "gear" },
  { username: "Wrench", iconEmoji: "wrench" },
  { username: "Hammer", iconEmoji: "hammer" },
  { username: "Microscope", iconEmoji: "microscope" },
  { username: "Telescope", iconEmoji: "telescope" },
  { username: "Satellite", iconEmoji: "satellite" },
  { username: "Anchor", iconEmoji: "anchor" },
  { username: "Shell", iconEmoji: "shell" },
  { username: "Seedling", iconEmoji: "seedling" },
  { username: "Herb", iconEmoji: "herb" },
  { username: "Maple Leaf", iconEmoji: "maple_leaf" },
  { username: "Pear", iconEmoji: "pear" },
  { username: "Lemon", iconEmoji: "lemon" },
  { username: "Grapes", iconEmoji: "grapes" },
  { username: "Apple", iconEmoji: "apple" },
  { username: "Rabbit", iconEmoji: "rabbit" },
  { username: "Turtle", iconEmoji: "turtle" },
  { username: "Whale", iconEmoji: "whale" },
  { username: "Octopus", iconEmoji: "octopus" },
  { username: "Beetle", iconEmoji: "beetle" },
];

function identityKey(identity: WorkerIdentity): string {
  return `${identity.username}|${identity.iconEmoji}`;
}

export function assignWorkerIdentity(workers: WorkerRecord[]): WorkerIdentity {
  const used = new Set(
    workers
      .map((worker) => worker.identity)
      .filter((identity): identity is WorkerIdentity => Boolean(identity))
      .map(identityKey),
  );
  const pool = WORKER_IDENTITIES.filter((identity) => !used.has(identityKey(identity)));
  const choices = pool.length > 0 ? pool : WORKER_IDENTITIES;
  return choices[Math.floor(Math.random() * choices.length)];
}

