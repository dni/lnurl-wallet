.PHONY: all format lint check test install dev build

all: format lint

format:
	npm run format

lint: format tsc

tsc:
	npm run tsc

check:
	npm run format:check

test:
	npm test

install:
	npm install

dev:
	npm run dev

build:
	npm run build
