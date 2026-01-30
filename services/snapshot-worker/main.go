package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"

	"github.com/fogleman/gg"
)

const defaultTileSize = 512

// Stroke matches tile-service/event-store shape (JSON numbers -> float64)
type Stroke struct {
	ID       string          `json:"id"`
	Ts       float64         `json:"ts"`
	Tool     string          `json:"tool"`
	Color    string          `json:"color"`
	Width    float64         `json:"width"`
	Points   [][]interface{} `json:"points"` // [[x,y], ...] from JSON
	AuthorID string          `json:"authorId,omitempty"`
	Hidden   bool            `json:"hidden,omitempty"`
}

// RenderRequest is the body for POST /render
type RenderRequest struct {
	TileX    int     `json:"tileX"`
	TileY    int     `json:"tileY"`
	TileSize int     `json:"tileSize"`
	Strokes  []Stroke `json:"strokes"`
}

func parsePoints(pts [][]interface{}) (pairs [][2]float64) {
	for _, p := range pts {
		if len(p) < 2 {
			continue
		}
		x, _ := toFloat(p[0])
		y, _ := toFloat(p[1])
		pairs = append(pairs, [2]float64{x, y})
	}
	return pairs
}

func toFloat(v interface{}) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	default:
		return 0, false
	}
}

func renderTileSnapshot(tileX, tileY, tileSize int, strokes []Stroke) ([]byte, error) {
	if tileSize <= 0 {
		tileSize = defaultTileSize
	}
	dc := gg.NewContext(tileSize, tileSize)
	dc.SetRGB(1, 1, 1)
	dc.Clear()

	x1 := float64(tileX * tileSize)
	y1 := float64(tileY * tileSize)

	for _, s := range strokes {
		if s.Hidden {
			continue
		}
		points := parsePoints(s.Points)
		if len(points) == 0 {
			continue
		}

		dc.SetLineCapRound()
		dc.SetLineJoinRound()
		dc.SetLineWidth(s.Width)

		if s.Tool == "eraser" {
			dc.SetRGB(1, 1, 1)
		} else {
			setHexColor(dc, s.Color)
		}

		dc.NewSubPath()
		for i, pt := range points {
			localX := pt[0] - x1
			localY := pt[1] - y1
			if i == 0 {
				dc.MoveTo(localX, localY)
			} else {
				dc.LineTo(localX, localY)
			}
		}
		dc.Stroke()
	}

	var buf bytes.Buffer
	if err := dc.EncodePNG(&buf); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func setHexColor(dc *gg.Context, hex string) {
	if len(hex) > 0 && hex[0] == '#' {
		hex = hex[1:]
	}
	if len(hex) == 6 {
		r, _ := strconv.ParseInt(hex[0:2], 16, 64)
		g, _ := strconv.ParseInt(hex[2:4], 16, 64)
		b, _ := strconv.ParseInt(hex[4:6], 16, 64)
		dc.SetRGB255(int(r), int(g), int(b))
		return
	}
	dc.SetRGB(0, 0, 0)
}

func handleRender(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	var req RenderRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	tileSize := req.TileSize
	if tileSize <= 0 {
		tileSize = defaultTileSize
	}
	pngBytes, err := renderTileSnapshot(req.TileX, req.TileY, tileSize, req.Strokes)
	if err != nil {
		log.Printf("[snapshot-worker] render error: %v", err)
		http.Error(w, "render failed", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Write(pngBytes)
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"status":"ok","service":"snapshot-worker"}`))
}

func main() {
	http.HandleFunc("/render", handleRender)
	http.HandleFunc("/health", handleHealth)
	port := "8080"
	if p := os.Getenv("PORT"); p != "" {
		port = p
	}
	log.Printf("Snapshot worker listening on :%s", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatal(err)
	}
}
