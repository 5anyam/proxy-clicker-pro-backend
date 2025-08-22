#!/bin/bash
set -e

echo "Installing system dependencies for Playwright..."

apt-get update

apt-get install -y \
  libglib2.0-0 \
  libnspr4 \
  libnss3 \
  libdbus-1-3 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libxcb1 \
  libxkbcommon0 \
  libatspi2.0-0 \
  libx11-6 \
  libxcomposite1 \
  libxdamage1 \
  libxext6 \
  libxfixes3 \
  libxrandr2 \
  libgbm1 \
  libcairo2 \
  libpango-1.0-0 \
  libasound2

echo "Installing Node dependencies..."
npm install

echo "Installing Playwright browsers..."
npx playwright install --with-deps chromium

echo "Build completed successfully!"
