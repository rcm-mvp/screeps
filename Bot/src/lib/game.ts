export function ownedRooms(): Room[] {
  const rooms: Room[] = [];
  for (const name in Game.rooms) {
    const room = Game.rooms[name];
    if (room.controller?.my) rooms.push(room);
  }
  return rooms;
}

/** Bucket with a sane fallback for sim/private servers where it's undefined. */
export function bucket(): number {
  return Game.cpu.bucket ?? 10000;
}
