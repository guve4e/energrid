#define _POSIX_C_SOURCE 200809L

#include <mosquitto_broker.h>
#include <mosquitto_plugin.h>

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/rand.h>
#include <openssl/sha.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#ifndef O_NOFOLLOW
#define O_NOFOLLOW 0
#endif
#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif

#define MOSQ_PLUGIN_SUCCESS 0

#define MAX_KEY_BYTES 256
#define MIN_KEY_BYTES 32
#define MAX_TOPIC_BYTES 1024
#define MAX_CLIENT_ID_BYTES 512
#define MAX_PEER_BYTES 128
#define MAX_EVENT_BYTES 8192
#define MAX_EVENTS_PER_SECOND 100
#define EVIDENCE_TOPIC "energrid/broker-evidence/v1"

struct plugin_state {
	char *broker_id;
	char *evidence_topic;
	unsigned char key[MAX_KEY_BYTES];
	size_t key_len;
};

static pthread_mutex_t rate_mutex = PTHREAD_MUTEX_INITIALIZER;
static time_t rate_second = 0;
static unsigned int rate_count = 0;

static bool take_rate_slot(void)
{
	struct timespec now;
	if(clock_gettime(CLOCK_MONOTONIC, &now) != 0) return false;
	if(pthread_mutex_trylock(&rate_mutex) != 0) return false;
	if(rate_second != now.tv_sec){
		rate_second = now.tv_sec;
		rate_count = 0;
	}
	bool allowed = rate_count < MAX_EVENTS_PER_SECOND;
	if(allowed) rate_count++;
	pthread_mutex_unlock(&rate_mutex);
	return allowed;
}

static bool valid_config_value(const char *value, size_t max_len)
{
	if(!value || !value[0] || strlen(value) > max_len) return false;
	for(const unsigned char *p = (const unsigned char *)value; *p; p++){
		if(*p < 0x20 || *p == 0x7f) return false;
	}
	return true;
}

static int load_key_file(const char *path, unsigned char *key, size_t *key_len)
{
	int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
	if(fd < 0) return -1;
	struct stat st;
	if(fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) || (st.st_mode & 077) != 0 ||
		st.st_size < MIN_KEY_BYTES || st.st_size > MAX_KEY_BYTES){
		close(fd);
		return -1;
	}
	size_t total = 0;
	while(total < MAX_KEY_BYTES){
		ssize_t n = read(fd, key + total, MAX_KEY_BYTES - total);
		if(n < 0 && errno == EINTR) continue;
		if(n <= 0) break;
		total += (size_t)n;
	}
	close(fd);
	while(total && (key[total - 1] == '\n' || key[total - 1] == '\r')) total--;
	if(total < MIN_KEY_BYTES || total > MAX_KEY_BYTES) return -1;
	*key_len = total;
	return 0;
}

static bool shelly_topic(const char *topic)
{
	if(!topic || strncmp(topic, "energrid/broker-evidence/", 25) == 0) return false;
	const char *device = topic;
	if(strncmp(topic, "shelly/", 7) == 0){
		device = topic + 7;
		const char *slash = strchr(device, '/');
		if(!slash) return false;
		for(const char *p = device; p < slash; p++){
			if(!((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') ||
				(*p >= '0' && *p <= '9') || *p == '-' || *p == '_' || *p == '.')) return false;
		}
		return true;
	}
	const char *slash = strchr(device, '/');
	if(!slash || (size_t)(slash - device) < 6) return false;
	if(strncasecmp(device, "shelly", 6) != 0) return false;
	for(const char *p = device; p < slash; p++){
		if(!((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') ||
			(*p >= '0' && *p <= '9') || *p == '-' || *p == '_' || *p == '.')) return false;
	}
	return true;
}

static int append_text(char *out, size_t cap, size_t *used, const char *text)
{
	size_t len = strlen(text);
	if(*used + len >= cap) return -1;
	memcpy(out + *used, text, len);
	*used += len;
	out[*used] = '\0';
	return 0;
}

static int append_quoted(char *out, size_t cap, size_t *used, const char *text)
{
	if(append_text(out, cap, used, "\"") != 0) return -1;
	for(const unsigned char *p = (const unsigned char *)text; *p; p++){
		char escaped[7];
		const char *piece = NULL;
		switch(*p){
			case '"': piece = "\\\""; break;
			case '\\': piece = "\\\\"; break;
			case '\b': piece = "\\b"; break;
			case '\f': piece = "\\f"; break;
			case '\n': piece = "\\n"; break;
			case '\r': piece = "\\r"; break;
			case '\t': piece = "\\t"; break;
			default:
				if(*p < 0x20){
					snprintf(escaped, sizeof(escaped), "\\u%04x", *p);
					piece = escaped;
				}
		}
		if(piece){
			if(append_text(out, cap, used, piece) != 0) return -1;
		}else{
			if(*used + 1 >= cap) return -1;
			out[(*used)++] = (char)*p;
			out[*used] = '\0';
		}
	}
	return append_text(out, cap, used, "\"");
}

static int canonical_event(char *out, size_t cap, const char *event_id,
	const char *broker_id, const char *kind, const char *client_id,
	const char *peer_ip, const char *topic, const char *payload_hash,
	const char *observed_at)
{
	size_t used = 0;
	out[0] = '\0';
	if(append_text(out, cap, &used, "{\"version\":1,\"eventId\":") ||
		append_quoted(out, cap, &used, event_id) ||
		append_text(out, cap, &used, ",\"brokerId\":") || append_quoted(out, cap, &used, broker_id) ||
		append_text(out, cap, &used, ",\"kind\":") || append_quoted(out, cap, &used, kind) ||
		append_text(out, cap, &used, ",\"clientId\":") || append_quoted(out, cap, &used, client_id) ||
		append_text(out, cap, &used, ",\"peerIp\":") || append_quoted(out, cap, &used, peer_ip) ||
		append_text(out, cap, &used, ",\"topic\":") ||
		(topic ? append_quoted(out, cap, &used, topic) : append_text(out, cap, &used, "null")) ||
		append_text(out, cap, &used, ",\"payloadSha256\":") ||
		(payload_hash ? append_quoted(out, cap, &used, payload_hash) : append_text(out, cap, &used, "null")) ||
		append_text(out, cap, &used, ",\"observedAt\":") || append_quoted(out, cap, &used, observed_at) ||
		append_text(out, cap, &used, "}")) return -1;
	return 0;
}

static int json_with_signature(char *out, size_t cap, const char *canonical,
	const unsigned char *key, size_t key_len)
{
	unsigned char digest[EVP_MAX_MD_SIZE];
	unsigned int digest_len = 0;
	if(!HMAC(EVP_sha256(), key, (int)key_len, (const unsigned char *)canonical,
		(unsigned int)strlen(canonical), digest, &digest_len) || digest_len != 32) return -1;
	char signature[65];
	for(unsigned int i = 0; i < digest_len; i++) snprintf(signature + i * 2, 3, "%02x", digest[i]);
	size_t canonical_len = strlen(canonical);
	if(canonical_len + 81 >= cap || canonical[canonical_len - 1] != '}') return -1;
	memcpy(out, canonical, canonical_len - 1);
	snprintf(out + canonical_len - 1, cap - canonical_len + 1, ",\"signature\":\"%s\"}", signature);
	OPENSSL_cleanse(digest, sizeof(digest));
	OPENSSL_cleanse(signature, sizeof(signature));
	return 0;
}

static void make_event_id(char out[37])
{
	unsigned char bytes[16];
	if(RAND_bytes(bytes, sizeof(bytes)) != 1){
		struct timespec ts;
		clock_gettime(CLOCK_REALTIME, &ts);
		memcpy(bytes, &ts, sizeof(ts) < sizeof(bytes) ? sizeof(ts) : sizeof(bytes));
	}
	snprintf(out, 37, "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
		bytes[0],bytes[1],bytes[2],bytes[3],bytes[4],bytes[5],bytes[6],bytes[7],
		bytes[8],bytes[9],bytes[10],bytes[11],bytes[12],bytes[13],bytes[14],bytes[15]);
	OPENSSL_cleanse(bytes, sizeof(bytes));
}

static int emit_event(struct plugin_state *state, struct mosquitto *client,
	const char *kind, const char *topic, const void *payload, uint32_t payload_len)
{
	if(!state || !client || !take_rate_slot()) return MOSQ_PLUGIN_SUCCESS;
	const char *client_id = mosquitto_client_id(client);
	const char *peer_ip = mosquitto_client_address(client);
	if(!valid_config_value(client_id, MAX_CLIENT_ID_BYTES) ||
		!valid_config_value(peer_ip, MAX_PEER_BYTES)) return MOSQ_PLUGIN_SUCCESS;
	if(topic && (!valid_config_value(topic, MAX_TOPIC_BYTES) || payload_len > 65536)) return MOSQ_PLUGIN_SUCCESS;

	char observed_at[32];
	struct timespec now;
	if(clock_gettime(CLOCK_REALTIME, &now) != 0) return MOSQ_PLUGIN_SUCCESS;
	struct tm utc;
	if(!gmtime_r(&now.tv_sec, &utc)) return MOSQ_PLUGIN_SUCCESS;
	if(strftime(observed_at, sizeof(observed_at), "%Y-%m-%dT%H:%M:%S", &utc) != 19) return MOSQ_PLUGIN_SUCCESS;
	snprintf(observed_at + 19, sizeof(observed_at) - 19, ".%03uZ",
		(unsigned int)(now.tv_nsec / 1000000));

	char event_id[37];
	make_event_id(event_id);
	char payload_hash[65];
	const char *hash_value = NULL;
	if(topic){
		unsigned char digest[SHA256_DIGEST_LENGTH];
		if(!SHA256(payload ? payload : "", payload_len, digest)) return MOSQ_PLUGIN_SUCCESS;
		for(size_t i = 0; i < sizeof(digest); i++) snprintf(payload_hash + i * 2, 3, "%02x", digest[i]);
		OPENSSL_cleanse(digest, sizeof(digest));
		hash_value = payload_hash;
	}

	char canonical[MAX_EVENT_BYTES];
	char envelope[MAX_EVENT_BYTES];
	if(canonical_event(canonical, sizeof(canonical), event_id, state->broker_id, kind,
		client_id, peer_ip, topic, hash_value, observed_at) != 0 ||
		json_with_signature(envelope, sizeof(envelope), canonical, state->key, state->key_len) != 0){
		return MOSQ_PLUGIN_SUCCESS;
	}
	(void)mosquitto_broker_publish_copy(NULL, state->evidence_topic,
		(int)strlen(envelope), envelope, 1, false, NULL);
	OPENSSL_cleanse(canonical, sizeof(canonical));
	OPENSSL_cleanse(envelope, sizeof(envelope));
	OPENSSL_cleanse(payload_hash, sizeof(payload_hash));
	return MOSQ_PLUGIN_SUCCESS;
}

static int on_message(int event, void *event_data, void *userdata)
{
	(void)event;
	struct mosquitto_evt_message *message = event_data;
	if(!message || !message->client || !message->topic || !shelly_topic(message->topic)) return MOSQ_PLUGIN_SUCCESS;
	struct plugin_state *state = userdata;
	return emit_event(state, message->client, "publish", message->topic,
		message->payload, message->payloadlen);
}

static int on_disconnect(int event, void *event_data, void *userdata)
{
	(void)event;
	struct mosquitto_evt_disconnect *disconnect = event_data;
	if(!disconnect || !disconnect->client) return MOSQ_PLUGIN_SUCCESS;
	return emit_event(userdata, disconnect->client, "disconnect", NULL, NULL, 0);
}

mosq_plugin_EXPORT int mosquitto_plugin_version(int supported_version_count, const int *supported_versions)
{
	for(int i = 0; i < supported_version_count; i++){
		if(supported_versions[i] == 5) return 5;
	}
	return -1;
}

mosq_plugin_EXPORT int mosquitto_plugin_init(mosquitto_plugin_id_t *identifier,
	void **userdata, struct mosquitto_opt *options, int option_count)
{
	struct plugin_state *state = calloc(1, sizeof(*state));
	if(!state) return 1;
	char *key_path = NULL;
	for(int i = 0; i < option_count; i++){
		if(!options[i].key || !options[i].value) continue;
		if(strcmp(options[i].key, "broker_id") == 0) state->broker_id = strdup(options[i].value);
		else if(strcmp(options[i].key, "evidence_topic") == 0) state->evidence_topic = strdup(options[i].value);
		else if(strcmp(options[i].key, "hmac_key_file") == 0) key_path = strdup(options[i].value);
	}
	if(!valid_config_value(state->broker_id, 128) ||
		!state->evidence_topic || strcmp(state->evidence_topic, EVIDENCE_TOPIC) != 0 ||
		!key_path || load_key_file(key_path, state->key, &state->key_len) != 0){
		free(key_path); free(state->broker_id); free(state->evidence_topic);
		OPENSSL_cleanse(state, sizeof(*state)); free(state);
		return 1;
	}
	free(key_path);
	*userdata = state;
	if(mosquitto_callback_register(identifier, MOSQ_EVT_MESSAGE, on_message, NULL, state) != MOSQ_PLUGIN_SUCCESS ||
		mosquitto_callback_register(identifier, MOSQ_EVT_DISCONNECT, on_disconnect, NULL, state) != MOSQ_PLUGIN_SUCCESS){
		mosquitto_callback_unregister(identifier, MOSQ_EVT_MESSAGE, on_message, NULL);
		mosquitto_callback_unregister(identifier, MOSQ_EVT_DISCONNECT, on_disconnect, NULL);
		free(state->broker_id); free(state->evidence_topic);
		OPENSSL_cleanse(state, sizeof(*state)); free(state);
		*userdata = NULL;
		return 1;
	}
	return 0;
}

mosq_plugin_EXPORT int mosquitto_plugin_cleanup(void *userdata,
	struct mosquitto_opt *options, int option_count)
{
	(void)options; (void)option_count;
	struct plugin_state *state = userdata;
	if(state){
		free(state->broker_id); free(state->evidence_topic);
		OPENSSL_cleanse(state, sizeof(*state)); free(state);
	}
	return 0;
}
