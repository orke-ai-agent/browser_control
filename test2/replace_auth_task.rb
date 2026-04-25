#!/usr/bin/env ruby
# frozen_string_literal: true

require 'json'
require 'net/http'
require 'optparse'
require 'time'
require 'uri'

class TrelloAuthTaskReplacer
  def initialize(options)
    @options = options
    @key = options.fetch(:key)
    @token = options.fetch(:token)
    @log_path = options.fetch(:log_path)
  end

  def run
    cards = request(:get, "/lists/#{@options.fetch(:list_id)}/cards", fields: 'id,name,pos,idLabels,desc')
    old_card = cards.find { |card| card['name'] == @options.fetch(:old_name) }
    raise "Old card not found: #{@options[:old_name]}" unless old_card

    first_new_name = 'MOB | Auth | Email sign in'
    second_new_name = 'MOB | Auth | Apple + Google sign in'

    existing = cards.each_with_object({}) { |card, acc| acc[card['name']] = card }
    next_pos = cards
      .map { |card| card['pos'] }
      .select { |pos| pos > old_card['pos'] }
      .min

    first_pos = old_card['pos']
    second_pos = next_pos ? ((old_card['pos'] + next_pos) / 2.0) : old_card['pos'] + 16384

    created = []

    unless existing[first_new_name]
      created << request(:post, '/cards', {
        idList: @options.fetch(:list_id),
        name: first_new_name,
        desc: build_desc(
          summary: 'Экран входа/регистрации по Email; обязательный consent с Terms/Privacy.',
          hours: 3,
          price: 30,
          stage: 'CORE',
          layer: 'MOB'
        ),
        pos: first_pos,
        idLabels: "#{@options.fetch(:core_label_id)},#{@options.fetch(:mob_label_id)}"
      })
    end

    unless existing[second_new_name]
      created << request(:post, '/cards', {
        idList: @options.fetch(:list_id),
        name: second_new_name,
        desc: build_desc(
          summary: 'Вход/регистрация через Apple и Google; обязательный consent с Terms/Privacy.',
          hours: 3,
          price: 30,
          stage: 'MVP',
          layer: 'MOB'
        ),
        pos: second_pos,
        idLabels: "#{@options.fetch(:mvp_label_id)},#{@options.fetch(:mob_label_id)}"
      })
    end

    request(:delete, "/cards/#{old_card.fetch('id')}")

    {
      deleted: old_card.slice('id', 'name'),
      created: created.map { |card| card.slice('id', 'name', 'pos') }
    }
  end

  private

  def build_desc(summary:, hours:, price:, stage:, layer:)
    [
      "Summary\n#{summary}",
      "Estimate\n- Hours: #{hours}h\n- Price: USD #{price}\n- Rate: USD 10/h",
      "Classification\n- Stage: #{stage}\n- Layer: #{layer}",
      "Source\n- Project: YouHollywood\n- Imported from: tasks_with_core_mvp.yaml"
    ].join("\n\n")
  end

  def request(method, path, params = {})
    uri = URI.parse("https://api.trello.com/1#{path}")
    query = { key: @key, token: @token }.merge(params)
    uri.query = URI.encode_www_form(query)

    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = true

    req = case method
          when :get then Net::HTTP::Get.new(uri)
          when :post then Net::HTTP::Post.new(uri)
          when :delete then Net::HTTP::Delete.new(uri)
          else raise "Unsupported method: #{method}"
          end

    response = http.request(req)
    body = sanitize_string(response.body.to_s)
    log_http(method, uri.to_s, response.code.to_i, body)
    raise "HTTP #{response.code}: #{body}" unless response.is_a?(Net::HTTPSuccess)

    body.empty? ? {} : JSON.parse(body)
  end

  def log_http(method, url, status, body)
    File.open(@log_path, 'a') do |file|
      file.puts(JSON.generate(sanitize_value({
        ts: Time.now.iso8601,
        method: method.to_s.upcase,
        url: url.gsub(@key, '[REDACTED_KEY]').gsub(@token, '[REDACTED_TOKEN]'),
        status: status,
        response_body: body
      })))
    end
  end

  def sanitize_value(value)
    case value
    when String
      sanitize_string(value)
    when Array
      value.map { |item| sanitize_value(item) }
    when Hash
      value.each_with_object({}) do |(key, item), acc|
        acc[sanitize_value(key)] = sanitize_value(item)
      end
    else
      value
    end
  end

  def sanitize_string(value)
    value
      .to_s
      .dup
      .force_encoding('UTF-8')
      .encode('UTF-8', invalid: :replace, undef: :replace, replace: '')
  end
end

class Hash
  def slice(*keys)
    keys.each_with_object({}) { |key, acc| acc[key] = self[key] if key?(key) }
  end
end

options = {
  log_path: File.expand_path("logs/trello-auth-replace-#{Time.now.strftime('%Y%m%d-%H%M%S')}.jsonl", __dir__)
}

OptionParser.new do |parser|
  parser.on('--list-id VALUE') { |value| options[:list_id] = value }
  parser.on('--old-name VALUE') { |value| options[:old_name] = value }
  parser.on('--core-label-id VALUE') { |value| options[:core_label_id] = value }
  parser.on('--mvp-label-id VALUE') { |value| options[:mvp_label_id] = value }
  parser.on('--mob-label-id VALUE') { |value| options[:mob_label_id] = value }
  parser.on('--key VALUE') { |value| options[:key] = value }
  parser.on('--token VALUE') { |value| options[:token] = value }
  parser.on('--log VALUE') { |value| options[:log_path] = value }
end.parse!

required = %i[list_id old_name core_label_id mvp_label_id mob_label_id key token]
missing = required.reject { |key| options[key] && !options[key].to_s.empty? }
abort("Missing required options: #{missing.join(', ')}") unless missing.empty?

puts JSON.pretty_generate(TrelloAuthTaskReplacer.new(options).run)
