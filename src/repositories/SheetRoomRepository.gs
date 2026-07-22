'use strict';

function SheetRoomRepository() {
  var SHEET = 'Rooms';
  var HEADERS = ['roomId', 'name', 'roomType', 'pricePerHour', 'pricePerNight', 'isAvailable'];

  function fromRow(row) {
    return { roomId: String(row[0]), name: String(row[1]), roomType: String(row[2]),
      pricePerHour: Number(row[3]), pricePerNight: Number(row[4]),
      isAvailable: row[5] === true || String(row[5]).toLowerCase() === 'true' };
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
