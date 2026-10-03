from dataclasses import dataclass
from typing import List, Optional


@dataclass
class Track:
    title: str
    artist: str
    seconds: int


class Playlist:
    def __init__(self, name: str, tracks: List[Track] = []):
        if not name.strip():
            raise ValueError("a playlist needs a name")
        self.name = name.strip()
        self.tracks = tracks

    def add(self, track: Track) -> None:
        if track.seconds <= 0:
            raise ValueError("track length must be positive")
        self.tracks.append(track)

    def remove(self, title: str) -> Optional[Track]:
        for i, t in enumerate(self.tracks):
            if t.title == title:
                return self.tracks.pop(i)
        return None

    def duration(self) -> int:
        return sum(t.seconds for t in self.tracks)

    def by_artist(self, artist: str) -> List[Track]:
        needle = artist.casefold()
        return [t for t in self.tracks if t.artist.casefold() == needle]


def merge(name: str, *playlists: Playlist) -> Playlist:
    merged = Playlist(name)
    seen = set()
    for p in playlists:
        for t in p.tracks:
            key = (t.title.casefold(), t.artist.casefold())
            if key not in seen:
                seen.add(key)
                merged.add(t)
    return merged
