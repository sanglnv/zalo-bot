'use strict';

function SheetRoomRepository() {
  var SHEET = 'Rooms';
  var HEADERS = ['roomId', 'name', 'roomType', 'hourlyRate', 'overnightRate', 'dailyRate', 'isAvailable'];

  function fromRow(row) {
    return { roomId: String(row[0]), name: String(row[1]), roomType: String(row[2]),
      hourlyRate: Number(row[3]), overnightRate: Number(row[4]), dailyRate: Number(row[5]) || 0,
      isAvailable: row[6] === true || String(row[6]).toLowerCase() === 'true' };
  }
  function list() {
    return SheetRepositorySupport.rows(SheetRepositorySupport.readSheet(SHEET)).map(fromRow);
  }
  function findById(roomId) {
    return list().find(function (room) { return room.roomId === String(roomId); }) || null;
  }
  return Object.freeze({ list: list, findById: findById });
}

if (typeof module !== 'undefined' && module.exports) module.exports = SheetRoomRepository;
