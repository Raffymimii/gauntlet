'use strict';

class BookingError extends Error {}

/**
 * Seat reservations for an event. `db` is a thin async wrapper over the database:
 * db.countReservations(eventId), db.getEvent(eventId), db.insertReservation(row).
 */
function createBookingService(db, { clock = () => new Date() } = {}) {
  async function reserve(eventId, userId, seats = 1) {
    if (!Number.isInteger(seats) || seats < 1 || seats > 6) {
      throw new BookingError('you can book between 1 and 6 seats');
    }
    const event = await db.getEvent(eventId);
    if (!event) throw new BookingError('no such event');
    if (event.startsAt <= clock()) throw new BookingError('the event has already started');

    const taken = await db.countReservations(eventId);
    if (taken + seats > event.capacity) {
      throw new BookingError('not enough seats left');
    }
    return db.insertReservation({ eventId, userId, seats, createdAt: clock() });
  }

  async function seatsLeft(eventId) {
    const event = await db.getEvent(eventId);
    if (!event) throw new BookingError('no such event');
    return Math.max(0, event.capacity - (await db.countReservations(eventId)));
  }

  return { reserve, seatsLeft };
}

module.exports = { createBookingService, BookingError };
