# Build
FROM golang:1.21-alpine AS builder
WORKDIR /app
RUN apk add --no-cache git
COPY go.mod ./
COPY main.go ./
RUN go mod tidy && CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /snapshot-worker .

##################################################################################

# Runtime: single binary, no Go runtime in image
FROM alpine:3.19 AS runtime
RUN apk add --no-cache ca-certificates
COPY --from=builder /snapshot-worker /snapshot-worker
EXPOSE 8080
ENV PORT=8080
CMD ["/snapshot-worker"]
