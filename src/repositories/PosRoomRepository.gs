'use strict';

/**
 * Room repository backed by the real POS SleepBox contract. The POS
 * contract has no standalone "list all rooms" or "get one room" action --
 * `checkAvailability(startAt, endAt)` is the only room-data action, and it
 * already returns only rooms that are free for that exact window. So
 * `bookingService.js` feature-detects this method and calls it directly at
 * both the select_slot and select_room steps instead of the
 * list()+findOverlapping()+findAvailableRooms local computation used by the
 * Sheet-backed SheetRoomRepository (Phase 1-4). `list`/`findById` still have
 * to exist to satisfy the room repository contract (repositoryContracts.js
 * asserts they are functions), but nothing calls them once checkAvailability
 * is present -- they throw clearly if that assumption is ever wrong.
 */
function PosRoomRepository() {
  function list() {
    throw new Error('PosRoomRepository.list is not supported by the POS contract; use checkAvailability(startAt, endAt)');
  }
  function findById() {
    throw new Error('PosRoomRepository.findById is not supported by the POS contract; use checkAvailability(startAt, endAt)');
  }
  function checkAvailability(startAt, endAt) {
    return SleepboxWebhookClient.checkAvailability(startAt, endAt);
  }
  return Object.freeze({ list: list, findById: findById, checkAvailability: checkAvailability });
}

if (typeof module !== 'undefined' && module.exports) module.exports = PosRoomRepository;
