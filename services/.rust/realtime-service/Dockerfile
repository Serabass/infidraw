FROM rust:1.91-bookworm AS builder
# Limit parallel jobs so multiple bake targets do not thrash (rand_chacha etc. are heavy)
ENV CARGO_BUILD_JOBS=2
WORKDIR /app
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
RUN cargo test --release && cargo build --release

FROM debian:bookworm-slim AS runtime
RUN apt-get update -y && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/realtime-service /usr/local/bin/
EXPOSE 3000
CMD ["realtime-service"]
