// What the signed-in person can do in Patrol. Set once from /patrol/me; the server still checks every action.

let current = { level: null, features: new Set() };

export function setAccess(me) {
  current = { level: me.access_level || null, features: new Set(me.features || []) };
}
export const has = (feature) => current.features.has(feature);
export const accessLevel = () => current.level;
