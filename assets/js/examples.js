// Example entries, loaded only when you click "Try example entries" (or ⋯ → Load example entries).
// Every one is tagged #example and can be removed in one click from the ⋯ menu.
// Country keys are the ISO 3166-1 numeric codes used by the map data.

export const EXAMPLES = [
  {
    type: 'place', title: 'Fushimi Inari Taisha', country: '392', location: 'Kyoto',
    lat: 34.9671, lng: 135.7727, tags: ['temples', 'hiking'],
    notes: 'Thousands of vermilion torii gates up Mount Inari. Go early in the morning; the full loop to the summit takes a couple of hours.',
    links: [{ label: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Fushimi_Inari-taisha' }],
  },
  {
    type: 'activity', title: 'See the northern lights', country: '578', location: 'Tromsø',
    lat: 69.6492, lng: 18.9553, tags: ['winter', 'nature'],
    notes: 'Aurora season in northern Norway runs roughly from September to March, when the nights are dark enough.',
    links: [{ label: 'Aurora (Wikipedia)', url: 'https://en.wikipedia.org/wiki/Aurora' }],
  },
  {
    type: 'place', title: 'Machu Picchu', country: '604', location: 'Cusco Region',
    lat: -13.1631, lng: -72.545, tags: ['hiking', 'history'],
    notes: 'Entry tickets are sold for timed slots, so book ahead in the dry season.',
    links: [{ label: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Machu_Picchu' }],
  },
  {
    type: 'activity', title: 'Drive the Ring Road', country: '352', location: 'Route 1',
    lat: 64.1466, lng: -21.9426, tags: ['road-trip', 'nature'],
    notes: 'Route 1 loops about 1,300 km around the island. Allow at least a week to do it without rushing.',
    links: [{ label: 'Route 1 (Wikipedia)', url: 'https://en.wikipedia.org/wiki/Route_1_(Iceland)' }],
  },
  {
    type: 'memory', title: 'The blue streets of Chefchaouen', country: '504', location: 'Chefchaouen',
    lat: 35.1688, lng: -5.2636, tags: ['photography'],
    notes: 'Example of something worth remembering: the whole old town is painted in shades of blue.',
    links: [{ label: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Chefchaouen' }],
  },
  {
    type: 'inspiration', title: 'Milford Sound boat trip', country: '554', location: 'Fiordland',
    lat: -44.6414, lng: 167.8974, tags: ['fjords', 'nature'],
    notes: 'Saved from a travel reel. Rainy days are said to be the best, with waterfalls everywhere.',
    links: [{ label: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Milford_Sound' }],
  },
  {
    type: 'place', title: 'Banff National Park', country: '124', location: 'Alberta',
    lat: 51.4968, lng: -115.9281, tags: ['hiking', 'lakes'],
    notes: 'Lake Louise and Moraine Lake are the classic stops.',
    links: [{ label: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Banff_National_Park' }],
  },
  {
    type: 'activity', title: 'Snorkel in Raja Ampat', country: '360', location: 'West Papua',
    lat: -0.2346, lng: 130.5079, tags: ['diving', 'islands'],
    notes: 'One of the most biodiverse coral reef areas in the world.',
    links: [{ label: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Raja_Ampat_Islands' }],
  },
  {
    type: 'inspiration', title: 'Night trains across Europe', country: null, location: '',
    lat: null, lng: null, tags: ['trains'],
    notes: 'An idea without a country yet. It stays in the library until you give it one.',
    links: [{ label: 'Sleeper trains (Wikipedia)', url: 'https://en.wikipedia.org/wiki/Sleeper_train' }],
  },
];
