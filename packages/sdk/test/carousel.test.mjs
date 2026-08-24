import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carouselSlotMs, nextCarouselId } from '../dist/carousel.js';

test('teilt die Standzeit des Screens auf die Elemente auf', () => {
  // Ein Durchlauf ist genau so lang wie der Screen: wer hinsieht, bis
  // weitergeschaltet wird, hat jedes Element genau einmal gesehen.
  assert.equal(carouselSlotMs(20, 1), 20_000);
  assert.equal(carouselSlotMs(20, 2), 10_000);
  assert.equal(carouselSlotMs(20, 3), 6667);
});

test('ohne brauchbare Zahlen bleibt der Takt null', () => {
  // Null heisst fuer den Aufrufer "nicht durchschalten" – und ist damit die
  // einzige Antwort, die nie in einen Timer mit falscher Laenge laeuft.
  assert.equal(carouselSlotMs(0, 2), 0);
  assert.equal(carouselSlotMs(Number.NaN, 2), 0);
  assert.equal(carouselSlotMs(20, 0), 0);
  assert.equal(carouselSlotMs(20, 1.5), 0);
});

test('zaehlt entlang der Bandreihenfolge weiter und laeuft im Kreis', () => {
  const order = ['a', 'b', 'c'];
  assert.equal(nextCarouselId(order, order, null), 'a');
  assert.equal(nextCarouselId(order, order, 'a'), 'b');
  assert.equal(nextCarouselId(order, order, 'c'), 'a');
});

test('ueberspringt, was gerade nichts zeigt', () => {
  // Spotify laeuft nicht: der Block steht im Band, bekommt aber keine Zeit.
  const order = ['sbb', 'spotify', 'kalender'];
  const eligible = ['sbb', 'kalender'];
  assert.equal(nextCarouselId(order, eligible, 'sbb'), 'kalender');
  assert.equal(nextCarouselId(order, eligible, 'kalender'), 'sbb');
});

test('faellt das gezeigte Element weg, geht es an seinem Platz weiter', () => {
  // Die Musik hoert mitten in ihrer Zeit auf. Der Durchlauf springt dann
  // nicht an den Anfang zurueck, sondern dorthin, wo er ohnehin hingegangen
  // waere – sonst saehe man das erste Element zweimal.
  const order = ['sbb', 'spotify', 'kalender'];
  assert.equal(nextCarouselId(order, ['sbb', 'kalender'], 'spotify'), 'kalender');
});

test('zeigt niemand etwas, kommt auch niemand dran', () => {
  assert.equal(nextCarouselId(['a', 'b'], [], 'a'), null);
  assert.equal(nextCarouselId([], [], null), null);
});

test('ein einziges Element bleibt stehen', () => {
  assert.equal(nextCarouselId(['a', 'b'], ['a'], 'a'), 'a');
});
