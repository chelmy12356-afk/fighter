class_name Fighter
extends Node2D
## Procedurally-drawn stickman fighter. No sprites, no assets - all code.

signal died(fighter)

enum State { IDLE, WALK, JUMP, PUNCH, KICK, BLOCK, HITSTUN, KO, VICTORY, UPPERCUT }

## Where this fighter's input comes from.
enum Ctrl { KEYS_P1, KEYS_P2, KEYS_ANY, CPU, REMOTE }

const GRAVITY := 2200.0
const MOVE_SPEED := 340.0
const JUMP_VEL := -780.0
const MAX_HEALTH := 100.0

# --- punch data ---
const PUNCH_STARTUP := 0.10
const PUNCH_ACTIVE := 0.14
const PUNCH_RECOVER := 0.18
const PUNCH_DMG := 8.0
const PUNCH_KB := 260.0
const PUNCH_LAUNCH := 140.0
const PUNCH_STUN := 0.30
const PUNCH_RADIUS := 16.0
# --- kick data ---
const KICK_STARTUP := 0.17
const KICK_ACTIVE := 0.16
const KICK_RECOVER := 0.30
const KICK_DMG := 14.0
const KICK_KB := 430.0
const KICK_LAUNCH := 300.0
const KICK_STUN := 0.45
const KICK_RADIUS := 18.0
# --- uppercut data (anti-air only: it can only hit an opponent who is in the air) ---
const UPPER_STARTUP := 0.07
const UPPER_ACTIVE := 0.20
const UPPER_RECOVER := 0.36
const UPPER_DMG := 16.0
const UPPER_KB := 220.0
const UPPER_LAUNCH := 620.0
const UPPER_STUN := 0.55
const UPPER_RADIUS := 32.0
const UPPER_MIN_HEIGHT := 28.0  # opponent's feet must be this far off the ground

# Input snapshot (plain class, no Dictionary literals).
class InputState:
	var left := false
	var right := false
	var jump := false
	var down := false
	var punch := false
	var kick := false
	var upper := false

	func clear() -> void:
		left = false
		right = false
		jump = false
		down = false
		punch = false
		kick = false
		upper = false

	func copy_from(o) -> void:
		left = o.left
		right = o.right
		jump = o.jump
		down = o.down
		punch = o.punch
		kick = o.kick
		upper = o.upper

	func to_bits() -> int:
		var b := 0
		if left:
			b |= 1
		if right:
			b |= 2
		if jump:
			b |= 4
		if down:
			b |= 8
		if punch:
			b |= 16
		if kick:
			b |= 32
		if upper:
			b |= 64
		return b

	func from_bits(b: int) -> void:
		left = (b & 1) != 0
		right = (b & 2) != 0
		jump = (b & 4) != 0
		down = (b & 8) != 0
		punch = (b & 16) != 0
		kick = (b & 32) != 0
		upper = (b & 64) != 0

# Skeleton pose: 12 joints in local space, facing RIGHT (+x = forward).
class Pose:
	var head := Vector2.ZERO
	var neck := Vector2.ZERO
	var shoulder := Vector2.ZERO
	var hip := Vector2.ZERO
	var elbowB := Vector2.ZERO
	var handB := Vector2.ZERO
	var elbowF := Vector2.ZERO
	var handF := Vector2.ZERO
	var kneeB := Vector2.ZERO
	var footB := Vector2.ZERO
	var kneeF := Vector2.ZERO
	var footF := Vector2.ZERO

var player_id := 1
var is_cpu := false
var control: int = Ctrl.KEYS_P1
var puppet := false  # online client: drawn from the host's snapshots, not simulated
var fighter_name := "PLAYER 1"
var color := Color(1.0, 0.42, 0.34)

var health := MAX_HEALTH
var state: int = State.IDLE
var velocity := Vector2.ZERO
var grounded := true
var facing := 1

var anim_time := 0.0
var attack_time := 0.0
var attacking := false
var has_hit := false
var whiff_played := false
var hitstun_time := 0.0
var flash_time := 0.0
var block_flash := 0.0
var fall_time := -1.0
var freeze_time := 0.0
var atk_serial := 0  # goes up by one every time this fighter starts an attack

# current attack parameters
var atk_startup := 0.0
var atk_active := 0.0
var atk_recover := 0.0
var atk_dmg := 0.0
var atk_kb := 0.0
var atk_launch := 0.0
var atk_stun := 0.0
var atk_radius := 0.0
var atk_heavy := false

var can_control := false
var ai_enabled := false
var target: Fighter = null
var main = null

var prev_input := InputState.new()
var ai_input := InputState.new()
var net_input := InputState.new()  # latest input received from the remote player

# --- AI ---
## Bot difficulty: 0.0 = pushover, 1.0 = brutal. Change this one number to taste.
var ai_skill := 0.7
var ai_timer := 0.0
var ai_action := "wait"
var ai_queue: Array = []
var ai_seen_serial := -1
var ai_react := -1.0
var ai_blocking := false
var ai_block_time := 0.0
var ai_punish := false
var ai_aa_ok := false
var ai_target_was_air := false
var ai_air_dir := 0
var ai_air_cross := false


# ============================== INPUT ==============================

static func read_keys(scheme: int) -> InputState:
	var inp := InputState.new()
	if scheme == Ctrl.KEYS_P1 or scheme == Ctrl.KEYS_ANY:
		inp.left = Input.is_key_pressed(KEY_A)
		inp.right = Input.is_key_pressed(KEY_D)
		inp.jump = Input.is_key_pressed(KEY_SPACE)
		inp.upper = Input.is_key_pressed(KEY_W)
		inp.down = Input.is_key_pressed(KEY_S)
		inp.punch = Input.is_key_pressed(KEY_F) or Input.is_mouse_button_pressed(MOUSE_BUTTON_LEFT)
		inp.kick = Input.is_key_pressed(KEY_G) or Input.is_mouse_button_pressed(MOUSE_BUTTON_RIGHT)
	if scheme == Ctrl.KEYS_P2 or scheme == Ctrl.KEYS_ANY:
		inp.left = inp.left or Input.is_key_pressed(KEY_LEFT)
		inp.right = inp.right or Input.is_key_pressed(KEY_RIGHT)
		inp.jump = inp.jump or Input.is_key_pressed(KEY_UP)
		inp.upper = inp.upper or Input.is_key_pressed(KEY_I)
		inp.down = inp.down or Input.is_key_pressed(KEY_DOWN)
		inp.punch = inp.punch or Input.is_key_pressed(KEY_K)
		inp.kick = inp.kick or Input.is_key_pressed(KEY_L)
	return inp


func read_input() -> InputState:
	if not can_control:
		return InputState.new()
	if control == Ctrl.CPU:
		return ai_input
	if control == Ctrl.REMOTE:
		return net_input
	return read_keys(control)


# ============================== UPDATE ==============================

func _physics_process(delta: float) -> void:
	if puppet:
		anim_time += delta
		scale.x = facing
		queue_redraw()
		return

	if freeze_time > 0.0:
		freeze_time -= delta
		queue_redraw()
		return

	anim_time += delta
	flash_time = max(0.0, flash_time - delta)
	block_flash = max(0.0, block_flash - delta)

	if control == Ctrl.CPU and ai_enabled and can_control:
		_update_ai(delta)

	var inp := read_input()

	if grounded and (state == State.IDLE or state == State.WALK) and target != null:
		var dx := target.global_position.x - global_position.x
		if abs(dx) > 4.0:
			facing = 1 if dx > 0.0 else -1

	match state:
		State.IDLE, State.WALK:
			_ground_control(inp, delta)
		State.JUMP:
			_air_control(inp, delta)
		State.PUNCH, State.KICK, State.UPPERCUT:
			_attack_update(delta)
		State.BLOCK:
			_block_update(inp, delta)
		State.HITSTUN:
			hitstun_time -= delta
			if grounded:
				velocity.x = move_toward(velocity.x, 0.0, 1400.0 * delta)
			if hitstun_time <= 0.0 and state == State.HITSTUN:
				state = State.IDLE if grounded else State.JUMP
		State.KO:
			if fall_time >= 0.0 and fall_time < 1.0:
				fall_time = min(1.0, fall_time + delta * 2.2)
			if grounded:
				velocity.x = move_toward(velocity.x, 0.0, 600.0 * delta)
		State.VICTORY:
			velocity.x = move_toward(velocity.x, 0.0, 2000.0 * delta)

	# --- physics ---
	velocity.y += GRAVITY * delta
	position += velocity * delta
	var g := 612.0
	if main != null:
		g = main.ground_y
	if position.y >= g:
		if not grounded:
			_land()
		position.y = g
		velocity.y = 0.0
		grounded = true
	else:
		grounded = false

	# --- body push (only near the ground, so you can jump over) ---
	if target != null and state != State.KO and target.state != State.KO:
		var dx2 := global_position.x - target.global_position.x
		if abs(dx2) < 44.0 and abs(global_position.y - target.global_position.y) < 90.0:
			var pdir := 1
			if dx2 < 0.0:
				pdir = -1
			position.x += (44.0 - abs(dx2)) * 0.5 * pdir

	if main != null:
		position.x = clamp(position.x, main.arena_left, main.arena_right)

	scale.x = facing
	prev_input.copy_from(inp)
	queue_redraw()


func _ground_control(inp: InputState, delta: float) -> void:
	if inp.down:
		state = State.BLOCK
		return
	if inp.jump and not prev_input.jump:
		velocity.y = JUMP_VEL
		grounded = false
		state = State.JUMP
		var jdir := 0
		if inp.right:
			jdir += 1
		if inp.left:
			jdir -= 1
		velocity.x = jdir * MOVE_SPEED * 0.95
		if main != null:
			main.play_sound("jump")
		return
	if inp.upper and not prev_input.upper:
		_start_attack(State.UPPERCUT)
		return
	if inp.punch and not prev_input.punch:
		_start_attack(State.PUNCH)
		return
	if inp.kick and not prev_input.kick:
		_start_attack(State.KICK)
		return
	var dir := 0
	if inp.right:
		dir += 1
	elif inp.left:
		dir -= 1
	if dir != 0:
		state = State.WALK
		velocity.x = dir * MOVE_SPEED
	else:
		state = State.IDLE
		velocity.x = move_toward(velocity.x, 0.0, 2400.0 * delta)


func _air_control(inp: InputState, delta: float) -> void:
	var dir := 0
	if inp.right:
		dir += 1
	elif inp.left:
		dir -= 1
	if dir != 0:
		velocity.x = move_toward(velocity.x, dir * MOVE_SPEED, 1500.0 * delta)
	if inp.punch and not prev_input.punch:
		_start_attack(State.PUNCH)
	elif inp.kick and not prev_input.kick:
		_start_attack(State.KICK)


func _block_update(inp: InputState, delta: float) -> void:
	if inp.down and grounded:
		velocity.x = move_toward(velocity.x, 0.0, 2200.0 * delta)
	else:
		state = State.IDLE


# ============================== COMBAT ==============================

func _load_attack(kind: int) -> void:
	if kind == State.PUNCH:
		atk_startup = PUNCH_STARTUP
		atk_active = PUNCH_ACTIVE
		atk_recover = PUNCH_RECOVER
		atk_dmg = PUNCH_DMG
		atk_kb = PUNCH_KB
		atk_launch = PUNCH_LAUNCH
		atk_stun = PUNCH_STUN
		atk_radius = PUNCH_RADIUS
		atk_heavy = false
	elif kind == State.KICK:
		atk_startup = KICK_STARTUP
		atk_active = KICK_ACTIVE
		atk_recover = KICK_RECOVER
		atk_dmg = KICK_DMG
		atk_kb = KICK_KB
		atk_launch = KICK_LAUNCH
		atk_stun = KICK_STUN
		atk_radius = KICK_RADIUS
		atk_heavy = true
	else:
		atk_startup = UPPER_STARTUP
		atk_active = UPPER_ACTIVE
		atk_recover = UPPER_RECOVER
		atk_dmg = UPPER_DMG
		atk_kb = UPPER_KB
		atk_launch = UPPER_LAUNCH
		atk_stun = UPPER_STUN
		atk_radius = UPPER_RADIUS
		atk_heavy = true


func _start_attack(kind: int) -> void:
	attacking = true
	attack_time = 0.0
	has_hit = false
	whiff_played = false
	atk_serial += 1
	state = kind
	_load_attack(kind)


func _attack_update(delta: float) -> void:
	attack_time += delta
	if grounded:
		velocity.x = move_toward(velocity.x, 0.0, 1800.0 * delta)
	if attack_time >= atk_startup and attack_time < atk_startup + atk_active:
		if not whiff_played:
			whiff_played = true
			if main != null:
				main.play_sound("whiff")
		if not has_hit and target != null and target.state != State.KO and _can_hit_target():
			var sp := _strike_point()
			if target.hurtbox_hit(sp, atk_radius):
				has_hit = true
				var kb_dir := 1
				if target.global_position.x < global_position.x:
					kb_dir = -1
				var blocked: bool = target.apply_hit(atk_dmg, atk_kb, atk_launch, atk_stun, kb_dir)
				if main != null:
					main.on_hit(self, target, atk_dmg, atk_heavy, sp, blocked)
	elif attack_time >= atk_startup + atk_active + atk_recover:
		attacking = false
		if grounded:
			state = State.IDLE
		else:
			state = State.JUMP


## Height of the feet above the floor.
func height() -> float:
	var g := 612.0
	if main != null:
		g = main.ground_y
	return max(0.0, g - position.y)


func _can_hit_target() -> bool:
	if state == State.UPPERCUT:
		# anti-air only: never touches a standing opponent
		return target.height() > UPPER_MIN_HEIGHT
	# a rising uppercut beats attacks coming from the air
	if not grounded and target.state == State.UPPERCUT and target.attack_time < target.atk_startup + target.atk_active:
		return false
	return true


func hurtbox_hit(point: Vector2, radius: float) -> bool:
	if state == State.KO:
		return false
	var c := to_global(Vector2(0.0, -58.0))
	return c.distance_to(point) < 46.0 + radius


func apply_hit(dmg: float, kb: float, launch: float, stun: float, from_dir: int) -> bool:
	if state == State.BLOCK and facing == -from_dir:
		# blocked (only when facing the attacker)
		health = max(0.0, health - dmg * 0.15)
		velocity.x = from_dir * kb * 0.45
		block_flash = 0.18
		if health <= 0.0:
			_die(from_dir)
		return true
	health = max(0.0, health - dmg)
	flash_time = 0.16
	attacking = false
	state = State.HITSTUN
	hitstun_time = stun
	velocity = Vector2(from_dir * kb, -launch)
	if health <= 0.0:
		_die(from_dir)
	return false


func _die(from_dir: int) -> void:
	state = State.KO
	health = 0.0
	fall_time = -1.0
	grounded = false
	velocity = Vector2(from_dir * 560.0, -480.0)
	if main != null:
		main.play_sound("ko")
	emit_signal("died", self)


func _land() -> void:
	if state == State.KO:
		if fall_time < 0.0:
			fall_time = 0.0
			velocity.x *= 0.3
			if main != null:
				main.play_sound("hit")
	elif state == State.JUMP:
		state = State.IDLE
	elif state == State.HITSTUN:
		velocity.x *= 0.55


func reset_round(pos_x: float, face: int) -> void:
	health = MAX_HEALTH
	state = State.IDLE
	velocity = Vector2.ZERO
	position = Vector2(pos_x, main.ground_y)
	facing = face
	attacking = false
	attack_time = 0.0
	hitstun_time = 0.0
	flash_time = 0.0
	block_flash = 0.0
	fall_time = -1.0
	freeze_time = 0.0
	grounded = true
	can_control = false
	ai_enabled = false
	ai_input.clear()
	net_input.clear()
	prev_input.clear()
	ai_queue.clear()
	ai_action = "wait"
	ai_timer = 0.0
	ai_react = -1.0
	ai_blocking = false
	ai_block_time = 0.0
	ai_target_was_air = false


func _in_active() -> bool:
	return attacking and attack_time >= atk_startup and attack_time < atk_startup + atk_active


func _in_recovery() -> bool:
	return attacking and attack_time >= atk_startup + atk_active


func _strike_point() -> Vector2:
	var p := _get_pose()
	if state == State.KICK:
		return to_global(p.footF)
	return to_global(p.handF)


# ============================== ONLINE SNAPSHOTS ==============================

func get_net_state() -> Array:
	return [position.x, position.y, velocity.y, state, facing, health, attack_time, attacking, fall_time, flash_time, block_flash]


func apply_net_state(a: Array) -> void:
	if a.size() < 11:
		return
	position = Vector2(a[0], a[1])
	velocity.y = a[2]
	var ns: int = a[3]
	if ns != state and (ns == State.PUNCH or ns == State.KICK or ns == State.UPPERCUT):
		_load_attack(ns)
	state = ns
	facing = a[4]
	health = a[5]
	attack_time = a[6]
	attacking = a[7]
	fall_time = a[8]
	flash_time = a[9]
	block_flash = a[10]


# ============================== AI ==============================

func _ai_cornered(dir: int) -> bool:
	# true when the wall is right behind us (dir = which side the opponent is on)
	if main == null:
		return false
	if dir > 0:
		return position.x - main.arena_left < 80.0
	return main.arena_right - position.x < 80.0


func _ai_press(what: String) -> void:
	if what == "punch":
		ai_input.punch = true
	elif what == "kick":
		ai_input.kick = true
	elif what == "upper":
		ai_input.upper = true


func _update_ai(delta: float) -> void:
	ai_input.clear()
	if target == null or target.state == State.KO:
		return
	var dx: float = target.position.x - position.x
	var dist: float = abs(dx)
	var dir: int = 1
	if dx < 0.0:
		dir = -1
	var free: bool = state == State.IDLE or state == State.WALK
	var t_h: float = target.height()

	# got hit: drop every plan and think again once we can move
	if state == State.HITSTUN:
		ai_queue.clear()
		ai_react = -1.0
		ai_blocking = false
		ai_action = "wait"
		ai_timer = 0.04
		return

	# --- in the air: steer, and kick on the way down ---
	if state == State.JUMP:
		ai_react = -1.0
		ai_blocking = false
		var want: int = ai_air_dir
		if not ai_air_cross:
			want = dir if dist > 85.0 else -dir
		ai_input.left = want < 0
		ai_input.right = want > 0
		if velocity.y > 150.0 and height() < 150.0 and dist < 112.0 and facing == dir and t_h < 60.0:
			ai_input.kick = true
		return

	# --- anti-air: uppercut a jumping opponent as they come down on us ---
	var t_air: bool = t_h > 24.0 and target.state != State.HITSTUN
	if t_air and not ai_target_was_air:
		ai_aa_ok = randf() < lerpf(0.25, 0.9, ai_skill)
	ai_target_was_air = t_air
	if free and t_air and ai_aa_ok and target.velocity.y > -350.0:
		var px: float = target.position.x + target.velocity.x * 0.09
		var ph: float = t_h - target.velocity.y * 0.09
		if abs(px - position.x) < 80.0 and ph > 36.0 and ph < 120.0:
			ai_input.upper = true
			ai_aa_ok = false
			ai_queue.clear()
			ai_react = -1.0
			return

	# --- defence: react ONCE to each new attack ---
	if target.attacking and target.atk_serial != ai_seen_serial:
		ai_seen_serial = target.atk_serial
		if dist < 170.0 and target.state != State.UPPERCUT:
			var r0 := randf()
			var guard: float = lerpf(0.25, 0.8, ai_skill)
			if r0 < guard:
				ai_react = randf_range(0.03, lerpf(0.26, 0.1, ai_skill))  # human-ish reaction time
				ai_punish = randf() < lerpf(0.3, 0.9, ai_skill)
			elif r0 < guard + 0.14 and not _ai_cornered(dir):
				ai_action = "retreat"
				ai_timer = 0.24
	if ai_react >= 0.0:
		ai_react -= delta
		if ai_react < 0.0:
			ai_blocking = true
			ai_block_time = 0.1
	if ai_blocking:
		# keep the guard up only while the attack can still hit, then let go
		if target.attacking and not target._in_recovery() and dist < 190.0:
			ai_block_time = max(ai_block_time, 0.05)
		ai_block_time -= delta
		if ai_block_time > 0.0:
			ai_input.down = true
			return
		ai_blocking = false
		if ai_punish and dist < 100.0:
			ai_queue = ["punch"]
		ai_timer = 0.05
		return

	# --- queued button presses (combos / punishes) ---
	if not ai_queue.is_empty():
		if free:
			if dist < 112.0:
				_ai_press(ai_queue.pop_front())
			else:
				ai_queue.clear()
		return

	if not free:
		return

	# --- punish a missed attack ---
	if target._in_recovery() and target.grounded and dist < 100.0 and randf() < lerpf(0.02, 0.5, ai_skill):
		var left_t: float = target.atk_startup + target.atk_active + target.atk_recover - target.attack_time
		if left_t > KICK_STARTUP + 0.02:
			ai_input.kick = true
			return
		if left_t > PUNCH_STARTUP * 0.5:
			ai_input.punch = true
			return

	# --- pick what to do next ---
	ai_timer -= delta
	if ai_timer <= 0.0:
		ai_timer = randf_range(0.07, 0.16) * lerpf(2.6, 0.9, ai_skill)
		_ai_decide(dist, dir)

	if ai_action == "approach":
		if dist > 72.0:
			ai_input.left = dir < 0
			ai_input.right = dir > 0
	elif ai_action == "retreat":
		ai_input.left = dir > 0
		ai_input.right = dir < 0
	elif ai_action == "jumpin" or ai_action == "crossup":
		ai_air_dir = dir
		ai_air_cross = ai_action == "crossup"
		ai_input.jump = true
		ai_input.left = dir < 0
		ai_input.right = dir > 0
		ai_action = "wait"


func _ai_decide(dist: float, dir: int) -> void:
	var r := randf()
	var cornered := _ai_cornered(dir)
	ai_action = "wait"

	# opponent is turtling: go around, bait, or chip - never just stand there
	if target.state == State.BLOCK and dist < 135.0:
		if r < 0.32:
			ai_action = "crossup"
		elif r < 0.52 and not cornered:
			ai_action = "retreat"
			ai_timer = 0.2
		elif r < 0.82:
			if dist < 100.0:
				ai_input.kick = true
			else:
				ai_action = "approach"
		return

	# ahead on health with the clock running out: stay away
	if main != null and main.time_left < 8.0 and health > target.health + 5.0:
		if dist < 190.0:
			ai_action = "crossup" if cornered else "retreat"
		return

	if dist > 300.0:
		ai_action = "approach" if r < 0.92 else "jumpin"
	elif dist > 150.0:
		if r < 0.74:
			ai_action = "approach"
		elif r < 0.84:
			ai_action = "jumpin"
		elif r < 0.93 or cornered:
			ai_action = "wait"
		else:
			ai_action = "retreat"
	elif dist > 98.0:
		if r < 0.8:
			ai_action = "approach"
		elif r < 0.92 or cornered:
			ai_action = "wait"
		else:
			ai_action = "retreat"
	elif target.state == State.HITSTUN:
		# they are reeling: keep the pressure on
		if r < 0.5:
			ai_input.punch = true
			ai_queue = ["kick"]
		elif r < 0.85:
			ai_input.kick = true
		else:
			ai_blocking = true
			ai_block_time = 0.22
			ai_punish = true
	else:
		if r < 0.4:
			ai_input.punch = true
			if randf() < 0.5:
				ai_queue = ["punch"]
		elif r < 0.68:
			ai_input.kick = true
		elif r < 0.8:
			ai_action = "crossup" if cornered else "retreat"
			ai_timer = 0.18
		elif r < 0.9:
			# short guard to bait a swing, then hit back
			ai_blocking = true
			ai_block_time = 0.25
			ai_punish = true


# ============================== POSES ==============================

func _get_pose() -> Pose:
	match state:
		State.IDLE:
			return _pose_idle()
		State.WALK:
			return _pose_walk()
		State.JUMP:
			return _pose_jump()
		State.BLOCK:
			return _pose_block()
		State.HITSTUN:
			return _pose_hit()
		State.KO:
			return _pose_ko_blend()
		State.VICTORY:
			return _pose_victory()
		State.PUNCH:
			return _pose_punch()
		State.KICK:
			return _pose_kick()
		State.UPPERCUT:
			return _pose_uppercut()
	return _pose_idle()


func _base(bob := 0.0) -> Pose:
	var p := Pose.new()
	p.head = Vector2(0, -94 + bob)
	p.neck = Vector2(0, -82 + bob)
	p.shoulder = Vector2(0, -76 + bob)
	p.hip = Vector2(0, -46 + bob)
	p.elbowB = Vector2(-8, -61 + bob)
	p.handB = Vector2(3, -69 + bob)
	p.elbowF = Vector2(10, -62 + bob)
	p.handF = Vector2(14, -73 + bob)
	p.kneeB = Vector2(-9, -24)
	p.footB = Vector2(-15, 0)
	p.kneeF = Vector2(9, -24)
	p.footF = Vector2(14, 0)
	return p


func _pose_idle() -> Pose:
	var b: float = sin(anim_time * 2.4) * 2.0
	var p := _base(b)
	var hb: float = sin(anim_time * 2.4 + 0.5) * 1.5
	p.handF = Vector2(14 + hb, -73 + b)
	p.handB = Vector2(3 - hb, -69 + b)
	return p


func _pose_walk() -> Pose:
	var p := _base()
	var ph: float = anim_time * 7.5
	var s: float = sin(ph)
	var lift_f: float = max(0.0, s)
	var lift_b: float = max(0.0, -s)
	var a: float = abs(s)
	p.footF = Vector2(15.0 * s, -lift_f * 9.0)
	p.footB = Vector2(-15.0 * s, -lift_b * 9.0)
	p.kneeF = Vector2(p.footF.x * 0.55 + 4.0, -24.0 - lift_f * 5.0)
	p.kneeB = Vector2(p.footB.x * 0.55 - 4.0, -24.0 - lift_b * 5.0)
	p.handF = Vector2(13.0 - 11.0 * s, -71)
	p.handB = Vector2(3.0 + 11.0 * s, -68)
	p.hip = Vector2(1, -45.0 + a * 2.0)
	p.head = Vector2(2, -94)
	p.neck = Vector2(1, -82)
	p.shoulder = Vector2(1, -76)
	return p


func _pose_jump() -> Pose:
	var p := _base()
	if velocity.y < 0.0:
		p.kneeF = Vector2(12, -34)
		p.footF = Vector2(19, -22)
		p.kneeB = Vector2(-7, -36)
		p.footB = Vector2(-12, -26)
		p.handF = Vector2(10, -97)
		p.elbowF = Vector2(13, -85)
		p.handB = Vector2(-9, -94)
		p.elbowB = Vector2(-7, -83)
	else:
		p.kneeF = Vector2(11, -26)
		p.footF = Vector2(17, -6)
		p.kneeB = Vector2(-9, -30)
		p.footB = Vector2(-16, -15)
		p.handF = Vector2(17, -82)
		p.elbowF = Vector2(12, -73)
		p.handB = Vector2(-14, -78)
		p.elbowB = Vector2(-9, -69)
	return p


func _pose_block() -> Pose:
	var p := _base(3.0)
	p.handF = Vector2(19, -82)
	p.elbowF = Vector2(12, -71)
	p.handB = Vector2(18, -66)
	p.elbowB = Vector2(9, -61)
	p.head = Vector2(1, -91)
	p.neck = Vector2(0, -80)
	p.shoulder = Vector2(0, -74)
	p.hip = Vector2(-2, -43)
	p.kneeF = Vector2(7, -22)
	p.footF = Vector2(12, 0)
	p.kneeB = Vector2(-9, -22)
	p.footB = Vector2(-17, 0)
	return p


func _pose_hit() -> Pose:
	var p := _base()
	p.head = Vector2(-8, -90)
	p.neck = Vector2(-5, -80)
	p.shoulder = Vector2(-4, -74)
	p.hip = Vector2(3, -46)
	p.handF = Vector2(-13, -85)
	p.elbowF = Vector2(-5, -76)
	p.handB = Vector2(20, -58)
	p.elbowB = Vector2(9, -63)
	p.kneeF = Vector2(15, -26)
	p.footF = Vector2(22, -8)
	p.kneeB = Vector2(-8, -22)
	p.footB = Vector2(-19, 0)
	return p


func _pose_ko_lie() -> Pose:
	var p := Pose.new()
	p.head = Vector2(-46, -10)
	p.neck = Vector2(-36, -13)
	p.shoulder = Vector2(-33, -16)
	p.hip = Vector2(-2, -17)
	p.elbowB = Vector2(-45, -25)
	p.handB = Vector2(-57, -16)
	p.elbowF = Vector2(-32, -27)
	p.handF = Vector2(-46, -31)
	p.kneeF = Vector2(16, -15)
	p.footF = Vector2(35, -7)
	p.kneeB = Vector2(9, -21)
	p.footB = Vector2(27, -16)
	return p


func _pose_ko_blend() -> Pose:
	if fall_time < 0.0:
		return _pose_hit()
	var lie := _pose_ko_lie()
	if fall_time >= 1.0:
		return lie
	var t: float = clamp(fall_time, 0.0, 1.0)
	return _lerp_pose(_pose_hit(), lie, t)


func _pose_victory() -> Pose:
	var p := _base()
	var hop: float = abs(sin(anim_time * 6.0)) * 6.0
	p.handF = Vector2(12, -104)
	p.elbowF = Vector2(14, -88)
	p.handB = Vector2(-11, -103)
	p.elbowB = Vector2(-12, -87)
	p.kneeF = Vector2(10, -24 + hop)
	p.footF = Vector2(16, -hop)
	p.kneeB = Vector2(-8, -24)
	p.footB = Vector2(-14, 0)
	return p


## 0 while winding up, 1 while the strike is out, easing back to 0 while recovering.
func _attack_ext() -> float:
	if attack_time < atk_startup:
		return 0.0
	if attack_time < atk_startup + atk_active:
		return 1.0
	if atk_recover <= 0.0:
		return 0.0
	var rt: float = (attack_time - atk_startup - atk_active) / atk_recover
	return 1.0 - clamp(rt, 0.0, 1.0)


func _pose_punch() -> Pose:
	if not attacking:
		return _base()
	var p := _base()
	var e: float = _attack_ext()
	var lean := e * 7.0
	p.head = Vector2(lean, -94)
	p.neck = Vector2(lean * 0.7, -82)
	p.shoulder = Vector2(lean * 0.5, -76)
	p.hip = Vector2(lean * 0.25, -46)
	p.handF = Vector2(14, -74).lerp(Vector2(40, -76), e)
	p.elbowF = Vector2(10, -62).lerp(Vector2(23, -75), e)
	p.handB = Vector2(-3.0 - 6.0 * e, -68)
	p.elbowB = Vector2(-8, -61)
	p.footF = Vector2(16.0 + 5.0 * e, 0)
	p.kneeF = Vector2(12, -24)
	return p


func _pose_kick() -> Pose:
	if not attacking:
		return _base()
	var p := _base()
	var e: float = _attack_ext()
	p.head = Vector2(-8.0 * e, -93)
	p.neck = Vector2(-6.0 * e, -82)
	p.shoulder = Vector2(-5.0 * e, -76)
	p.hip = Vector2(-5.0 * e, -49)
	p.footF = Vector2(14, 0).lerp(Vector2(44, -46), e)
	p.kneeF = Vector2(9, -24).lerp(Vector2(23, -45), e)
	p.footB = Vector2(-5, 0)
	p.kneeB = Vector2(-3, -24)
	p.handF = Vector2(5, -90 + 12.0 * e)
	p.elbowF = Vector2(10, -79)
	p.handB = Vector2(-18, -68)
	p.elbowB = Vector2(-8, -64)
	return p


func _pose_uppercut() -> Pose:
	if not attacking:
		return _base()
	if attack_time < atk_startup:
		# quick crouch before the rise
		var c: float = clamp(attack_time / max(atk_startup, 0.001), 0.0, 1.0) * 9.0
		var q := _base(c)
		q.handF = Vector2(12, -52 + c)
		q.elbowF = Vector2(3, -60 + c)
		q.kneeF = Vector2(13, -22)
		q.kneeB = Vector2(-12, -22)
		return q
	var p := _base()
	var e: float = _attack_ext()
	var up: float = -10.0 * e
	p.head = Vector2(3.0 * e, -94 + up)
	p.neck = Vector2(2.0 * e, -82 + up)
	p.shoulder = Vector2(2.0 * e, -76 + up)
	p.hip = Vector2(e, -46 + up * 0.6)
	p.handF = Vector2(14, -73).lerp(Vector2(20, -122), e)
	p.elbowF = Vector2(10, -62).lerp(Vector2(15, -103), e)
	p.handB = Vector2(-6, -62)
	p.elbowB = Vector2(-10, -67)
	p.footB = Vector2(-15, 0).lerp(Vector2(-12, -8), e)
	p.kneeB = Vector2(-9, -24).lerp(Vector2(-5, -31), e)
	return p


func _lerp_pose(a: Pose, b: Pose, t: float) -> Pose:
	var out := Pose.new()
	out.head = a.head.lerp(b.head, t)
	out.neck = a.neck.lerp(b.neck, t)
	out.shoulder = a.shoulder.lerp(b.shoulder, t)
	out.hip = a.hip.lerp(b.hip, t)
	out.elbowB = a.elbowB.lerp(b.elbowB, t)
	out.handB = a.handB.lerp(b.handB, t)
	out.elbowF = a.elbowF.lerp(b.elbowF, t)
	out.handF = a.handF.lerp(b.handF, t)
	out.kneeB = a.kneeB.lerp(b.kneeB, t)
	out.footB = a.footB.lerp(b.footB, t)
	out.kneeF = a.kneeF.lerp(b.kneeF, t)
	out.footF = a.footF.lerp(b.footF, t)
	return out


# ============================== DRAWING ==============================

func _draw() -> void:
	var p := _get_pose()
	var body_col := color
	var back_col := color.darkened(0.45)
	if flash_time > 0.0:
		body_col = Color(1, 1, 1)
		back_col = Color(1, 1, 1)
	elif block_flash > 0.0:
		body_col = color.lerp(Color(1, 0.9, 0.3), 0.6)
		back_col = color.darkened(0.45).lerp(Color(1, 0.9, 0.3), 0.6)

	# shadow on the ground
	if main != null:
		var g: float = main.ground_y
		var h_above: float = max(0.0, g - position.y)
		var sh: float = clamp(1.0 - h_above / 320.0, 0.25, 1.0)
		draw_set_transform(Vector2(0, h_above + 5.0))
		draw_line(Vector2(-38.0 * sh, 0), Vector2(38.0 * sh, 0), Color(0, 0, 0, 0.28), 9.0 * sh)
		draw_set_transform(Vector2.ZERO)

	var w := 5.0
	# back limbs
	draw_line(p.hip, p.kneeB, back_col, w)
	draw_line(p.kneeB, p.footB, back_col, w)
	draw_circle(p.footB, 3.5, back_col)
	draw_line(p.shoulder, p.elbowB, back_col, w)
	draw_line(p.elbowB, p.handB, back_col, w)
	draw_circle(p.handB, 3.5, back_col)
	# torso
	draw_line(p.hip, p.neck, body_col, w + 1.5)
	# front limbs
	draw_line(p.hip, p.kneeF, body_col, w)
	draw_line(p.kneeF, p.footF, body_col, w)
	draw_circle(p.footF, 4.0, body_col)
	draw_line(p.shoulder, p.elbowF, body_col, w)
	draw_line(p.elbowF, p.handF, body_col, w)
	draw_circle(p.handF, 4.0, body_col)
	# head + eye
	draw_arc(p.head, 13.0, 0.0, TAU, 26, body_col, 4.0)
	draw_circle(p.head + Vector2(5.5, -2.0), 2.0, body_col)

	# block shield arc
	if state == State.BLOCK:
		draw_arc(Vector2(22, -62), 27.0, -1.1, 1.1, 18, Color(0.45, 0.8, 1.0, 0.55), 3.0)

	# speed lines while striking
	if (state == State.PUNCH or state == State.KICK or state == State.UPPERCUT) and _in_active():
		var pt := p.handF
		var origin := p.elbowF
		if state == State.KICK:
			pt = p.footF
			origin = p.kneeF
		var dir: Vector2 = (pt - origin).normalized()
		var side := Vector2(-dir.y, dir.x)
		for i in 3:
			var off: Vector2 = side * (-7.0 + i * 7.0)
			draw_line(pt - dir * (12.0 + i * 10.0) + off, pt - dir * (20.0 + i * 10.0) + off, Color(1, 1, 1, 0.35), 2.0)
