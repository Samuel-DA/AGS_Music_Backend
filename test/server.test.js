import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isYouTubeVideoId,
  parseISO8601Duration,
  parsePostTitle,
} from '../server.js';

test('accepts only canonical YouTube video ids', () => {
  assert.equal(isYouTubeVideoId('F8A6OKF7fJA'), true);
  assert.equal(isYouTubeVideoId('bad;touch-x'), false);
  assert.equal(isYouTubeVideoId('too-short'), false);
});

test('parses ISO 8601 video durations', () => {
  assert.equal(parseISO8601Duration('PT3M13S'), 193);
  assert.equal(parseISO8601Duration('PT1H2M3S'), 3723);
  assert.equal(parseISO8601Duration('invalid'), 0);
});

test('normalises direct-source artist and song titles', () => {
  assert.deepEqual(
    parsePostTitle('DOWNLOAD SONG: Davido – Stand Strong [Mp3 + Lyrics]'),
    { title: 'Stand Strong', artist: 'Davido' },
  );
  assert.deepEqual(
    parsePostTitle(
      'Twe Twe [Remix] Mp3 Download – Kizz Daniel & Davido (Song & Lyrics)',
    ),
    { title: 'Twe Twe [Remix]', artist: 'Kizz Daniel & Davido' },
  );
});
