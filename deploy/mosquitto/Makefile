CC ?= cc
MOSQUITTO_INCLUDE_DIR ?= /usr/include
OUTPUT ?= build/energrid-broker-evidence.so
CFLAGS ?= -O2 -Wall -Wextra -Werror

.PHONY: all clean
all: $(OUTPUT)

$(OUTPUT): energrid-broker-evidence.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -std=c11 -fPIC -shared -I$(MOSQUITTO_INCLUDE_DIR) $< -o $@ -lcrypto -pthread

clean:
	rm -rf build
