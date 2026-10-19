import type { MapDefinition } from "../map.js";

/**
 * The office: open space, cafeteria, meeting room, lounge and reception.
 * Legend: # wall · . floor · = door · D desk · c chair · T table · K counter · P plant · S sofa · B whiteboard
 */
export const OFFICE_MAP: MapDefinition = {
  id: "office",
  rows: [
    "########################################", //  0
    "#P......................P#KKKKKKKKKKKKK#", //  1  open space | cafeteria
    "#........................#.............#", //  2
    "#..cccc....cccc....cccc..#..cc....cc...#", //  3
    "#..DDDD....DDDD....DDDD..#.cTTc..cTTc..#", //  4
    "#..DDDD....DDDD....DDDD..#..cc....cc...#", //  5
    "#..cccc....cccc....cccc..=.............#", //  6
    "#........................#..cc....cc...#", //  7
    "#..cccc....cccc....cccc..#.cTTc..cTTc..#", //  8
    "#..DDDD....DDDD....DDDD..#..cc....cc..P#", //  9
    "#..DDDD....DDDD....DDDD..#####==########", // 10
    "#..cccc....cccc....cccc................#", // 11  corridor
    "#P.....................................#", // 12
    "#..........................#####==######", // 13
    "#####==#####...............#..BBB......#", // 14  reception | lounge | meeting room
    "#..........#.....SSSS......#..cccccc...#", // 15
    "#..KKK.....#..S........S...#.cTTTTTTc..#", // 16
    "#..........#..S...TT...S...#.cTTTTTTc..#", // 17
    "#..........#..S........S...#..cccccc...#", // 18
    "#P........P#.....SSSS.....P#P.........P#", // 19
    "#####==#################################", // 20  entrance
  ],
  spawn: [5, 18],
  zones: [
    { name: "cafeteria", from: [26, 1], to: [38, 9] },
    { name: "meeting_room", from: [28, 14], to: [38, 19] },
    { name: "reception", from: [1, 15], to: [10, 20] },
    { name: "lounge", from: [12, 14], to: [26, 19] },
    { name: "corridor", from: [25, 10], to: [38, 13] },
    { name: "open_space", from: [1, 1], to: [27, 14] },
  ],
};
