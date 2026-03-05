FROM rust:1.91-bookworm AS builder
RUN cargo install sccache --locked
ARG SCCACHE_REDIS_ENDPOINT
ENV RUSTC_WRAPPER=sccache
ENV SCCACHE_REDIS_ENDPOINT=${SCCACHE_REDIS_ENDPOINT}
ENV SCCACHE_LOG=info
WORKDIR /app
COPY Cargo.toml Cargo.lock* ./
RUN mkdir -p src && echo 'fn main() {}' > src/main.rs
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/app/target \
    cargo build --release
COPY src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/app/target \
    cargo test --release && cargo build --release

FROM debian:bookworm-slim AS runtime
RUN apt-get update -y && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/admin-service /usr/local/bin/
EXPOSE 3000
CMD ["admin-service"]
